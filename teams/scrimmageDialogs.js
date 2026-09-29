/*
 * Intrasquad scrimmage — the New Scrimmage and Edit Squads dialogs, the
 * creation of the two squad-games, and the application of a squad edit. The
 * rules (dealing players, naming, grouping, versioning a squad) live in
 * store/scrimmage.js; this file owns the DOM, the Game construction and the
 * server round-trips.
 *
 * A scrimmage is two ordinary Games sharing a scrimmageId, one per squad, each
 * from its own squad's side (team = this squad, opponent = the other, roster
 * snapshot = this squad's players). Both are created here, at once, by
 * whichever coach opens the dialog, and both are synced: the other coach then
 * opens the team and taps Track on their squad.
 *
 * Squads can be changed afterwards — from the team card or from inside a
 * squad-game, even mid-point — with the same picker. A save PATCHes each
 * changed half's squad definition (store/sync.js patchScrimmageGame); the
 * other coaches' phones adopt it on their next refresh and say what changed.
 * Players can be added to the roster from the dialog too, so a late arrival
 * does not cost the assignments already made. See ARCHITECTURE.md
 * § Intrasquad Scrimmages.
 */
import { Game, Gender } from '../store/models.js';
import { teams, currentTeam, setCurrentEvent, saveAllTeamsData } from '../store/storage.js';
import {
    syncGameToCloud, generateGameId, authFetch, API_BASE_URL, listServerGames,
    patchScrimmageGame,
} from '../store/sync.js';
import {
    SQUADS, DEFAULT_SQUAD_NAMES, normalizeSquadNames, generateScrimmageId,
    squadGameFields, buildSquadSnapshot, splitSquads, otherSquad, squadRoster,
    groupScrimmages, scrimmageSquadNames, squadAssignments, squadPatch,
    squadDefinition, applySquadDefinition, describeSquadChange,
} from '../store/scrimmage.js';
import { formatPlayerName, currentGame, isPointInProgress } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { isGameScreenVisible } from '../ui/panelSystem.js';
import { setCountdownSeconds } from '../game/pointManagement.js';
import { showControllerToast } from '../game/controllerState.js';
import { selectCloudTeam, populateCloudTeamsAndGames } from './teamList.js';
import { addPlayerToRoster, showEditPlayerDialog } from './rosterManagement.js';
import { log } from '../utils/logger.js';

// The open dialog's working state; null when no dialog is open.
//   mode        'new' | 'edit'
//   team        the team as the API lists it (or the local Team, from a game)
//   modal       the dialog element
//   roster      the players the picker lists: the team roster, plus (edit mode)
//               anyone still on a squad but no longer on the team ("ghosts")
//   ghosts      ids of those
//   assignment  playerId → 'X' | 'Y' (absent = sitting out)
//   names       the squad names as typed
//   pulling     which squad pulls first (new mode)
//   edit        { scrimmageId, games: {X?, Y?} } — the halves being edited:
//               this device's live Game for the half it is tracking, the
//               server's document for the other
let state = null;

const byDisplayName = (a, b) =>
    formatPlayerName(a).toLowerCase().localeCompare(formatPlayerName(b).toLowerCase());

/** The team roster in the order the roster screen lists it (by display name). */
function sortedRoster(team) {
    const roster = (team && team.teamRoster) ? team.teamRoster.slice() : [];
    return roster.sort(byDisplayName);
}

/** Player ids currently on each squad, in roster order. */
function squadIds() {
    const ids = { X: [], Y: [] };
    state.roster.forEach(p => {
        const squad = state.assignment.get(p.id);
        if (squad) ids[squad].push(p.id);
    });
    return ids;
}

/** Replace the assignment with a fresh deal (only the given players move). */
function applySplit(split) {
    state.assignment = new Map();
    SQUADS.forEach(squad => split[squad].forEach(id => state.assignment.set(id, squad)));
}

/**
 * The picker's rows: the team roster as it stands now and, when editing,
 * anyone still on a squad who has since left the team (shown marked, so the
 * coach can sit them out). Assignments of players who are gone are dropped.
 */
function rebuildRoster() {
    const roster = sortedRoster(currentTeam);
    const ghosts = new Set();
    if (state.edit) {
        const live = (currentTeam && currentTeam.teamRoster) || [];
        SQUADS.forEach(squad => {
            squadRoster(state.edit.games[squad], live).forEach(p => {
                if (live.includes(p) || roster.some(r => r.id === p.id)) return;
                roster.push(p);
                ghosts.add(p.id);
            });
        });
        roster.sort(byDisplayName);
    }
    state.roster = roster;
    state.ghosts = ghosts;
    [...state.assignment.keys()].forEach(id => {
        if (!roster.some(p => p.id === id)) state.assignment.delete(id);
    });
}

// ── the dialog ──────────────────────────────────────────────────────────

/**
 * Build and show the dialog shell for either mode; the roster lands later.
 * @param {'new'|'edit'} mode
 * @param {object} team
 * @returns {HTMLElement} the modal
 */
function openDialog(mode, team) {
    document.getElementById('newScrimmageModal')?.remove();
    document.getElementById('editSquadsModal')?.remove();

    const modal = document.createElement('div');
    modal.id = mode === 'edit' ? 'editSquadsModal' : 'newScrimmageModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content event-dialog scrimmage-dialog">
            <div class="dialog-header prominent-dialog-header">
                <h2>${mode === 'edit' ? 'Edit Squads' : 'New Scrimmage'}</h2>
                <span class="close">&times;</span>
            </div>
            <div class="event-dialog-body">
                <input type="text" id="newScrimmageName" class="event-dialog-input"
                       placeholder="Label (optional) — e.g. Tuesday practice" maxlength="40">
                <div class="scrimmage-squad-names">
                    <input type="text" id="scrimmageSquadNameX" class="event-dialog-input scrimmage-squad-name"
                           value="${DEFAULT_SQUAD_NAMES.X}" maxlength="20" aria-label="First squad name">
                    <span class="scrimmage-vs">vs</span>
                    <input type="text" id="scrimmageSquadNameY" class="event-dialog-input scrimmage-squad-name"
                           value="${DEFAULT_SQUAD_NAMES.Y}" maxlength="20" aria-label="Second squad name">
                </div>
                <div class="scrimmage-tools">
                    <button type="button" id="scrimmageShuffleBtn" class="scrimmage-tool-btn" title="Re-deal the players on a squad, balanced by gender and position">
                        <i class="fas fa-random"></i> Shuffle
                    </button>
                    <button type="button" id="scrimmageClearBtn" class="scrimmage-tool-btn" title="Take everyone off both squads">
                        Clear
                    </button>
                    <span class="scrimmage-sitting" id="scrimmageSitting"></span>
                </div>
                <div class="scrimmage-picker-scroll">
                    <table class="scrimmage-picker">
                        <thead>
                            <tr>
                                <th class="scrimmage-player-col">Player</th>
                                <th class="scrimmage-squad-col" data-squad="X"></th>
                                <th class="scrimmage-squad-col" data-squad="Y"></th>
                            </tr>
                        </thead>
                        <tbody id="scrimmagePickerBody">
                            <tr><td colspan="3" class="scrimmage-loading">Loading roster…</td></tr>
                        </tbody>
                    </table>
                </div>
                <div class="scrimmage-add-row management-controls" title="Add a player to the team roster without leaving the dialog">
                    <input type="text" id="scrimmageNewPlayerName" placeholder="Add player" maxlength="40" autocomplete="off">
                    <input type="text" id="scrimmageNewPlayerNumber" placeholder="#" class="player-number-input" autocomplete="off">
                    <div class="management-icons">
                        <button type="button" id="scrimmageAddFMPBtn" class="icon-button gender-button fmp-button">+FMP</button>
                        <button type="button" id="scrimmageAddMMPBtn" class="icon-button gender-button mmp-button">+MMP</button>
                    </div>
                </div>
                ${mode === 'edit' ? `
                <div class="scrimmage-start-row scrimmage-save-row">
                    <button type="button" id="scrimmageSaveBtn" class="event-dialog-submit scrimmage-start-btn scrimmage-save-btn">
                        <i class="fas fa-check"></i> Save squads
                    </button>
                </div>
                <p class="text-hint scrimmage-hint">
                    Saving updates both squads' games at once; a coach tracking either
                    squad sees the change on their phone. A point already on the field
                    keeps its line — the new squads play from the next point.
                </p>` : `
                <div class="event-dialog-row scrimmage-pull-row">
                    <span>First pull by</span>
                    <span class="scrimmage-pull-toggle" role="radiogroup" aria-label="Which squad pulls first">
                        <button type="button" class="scrimmage-pull-btn" data-squad="X"></button>
                        <button type="button" class="scrimmage-pull-btn" data-squad="Y"></button>
                    </span>
                </div>
                <div class="scrimmage-start-row">
                    <button type="button" id="scrimmageStartX" class="event-dialog-submit scrimmage-start-btn" data-squad="X"></button>
                    <button type="button" id="scrimmageStartY" class="event-dialog-submit scrimmage-start-btn" data-squad="Y"></button>
                </div>
                <p class="text-hint scrimmage-hint">
                    Both squads' games are created now. The other coach opens this team
                    and taps <strong>Track</strong> on their squad; each of you keeps stats
                    for one squad. Squads can be changed later, from the card or from
                    inside a game. Scrimmages stay out of the team's games, events and
                    all-time stats — see <strong>Scrimmages</strong> on the team card.
                </p>`}
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    state = {
        mode,
        team,
        modal,
        roster: [],
        ghosts: new Set(),
        assignment: new Map(),
        names: { ...DEFAULT_SQUAD_NAMES },
        pulling: 'X',
        busy: false,
        edit: null,
        justAdded: null,
    };

    modal.querySelector('.close').onclick = closeDialog;
    modal.onclick = (e) => { if (e.target === modal) closeDialog(); };

    // Names and the pull toggle work before the roster lands.
    SQUADS.forEach(squad => {
        const input = modal.querySelector(`#scrimmageSquadName${squad}`);
        input.addEventListener('input', () => {
            state.names[squad] = input.value;
            renderNames();
        });
    });
    modal.querySelectorAll('.scrimmage-pull-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.pulling = btn.dataset.squad;
            renderNames();
        });
    });
    modal.querySelector('#scrimmageShuffleBtn').addEventListener('click', () => {
        // Re-deal only the players who are on a squad — the coach may have
        // taken absentees off first. Nobody on a squad yet: deal everyone.
        const onSquad = state.roster.filter(p => state.assignment.get(p.id));
        applySplit(splitSquads(onSquad.length ? onSquad : state.roster, { shuffle: true }));
        renderTable();
    });
    modal.querySelector('#scrimmageClearBtn').addEventListener('click', () => {
        state.assignment = new Map();
        renderTable();
    });
    modal.querySelectorAll('.scrimmage-start-btn[data-squad]').forEach(btn => {
        btn.addEventListener('click', () => startScrimmage(btn.dataset.squad));
    });
    modal.querySelector('#scrimmageSaveBtn')?.addEventListener('click', saveSquadEdit);
    wireAddPlayerRow(modal);
    renderNames();
    return modal;
}

function closeDialog() {
    if (!state) return;
    state.modal.remove();
    state = null;
}

/** True while `modal` is still the open dialog (not closed or replaced meanwhile). */
function stillOpen(modal) {
    return !!state && state.modal === modal;
}

function showPickerMessage(text) {
    const body = state?.modal.querySelector('#scrimmagePickerBody');
    if (!body) return;
    body.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'scrimmage-loading';
    td.textContent = text;
    tr.appendChild(td);
    body.appendChild(tr);
}

/**
 * Open the New Scrimmage dialog for a team. The roster comes from the local
 * Team, loading it first when this device has not opened the team yet (the
 * dialog shows a placeholder row meanwhile).
 * @param {object} team - the team as the API lists it
 */
function showNewScrimmageDialog(team) {
    const modal = openDialog('new', team);

    // Make sure the team (and its roster) is in local state, without leaving
    // the team list behind the dialog.
    selectCloudTeam(team, { landOn: 'none' }).then(() => {
        if (!stillOpen(modal)) return;   // closed meanwhile
        rebuildRoster();
        applySplit(splitSquads(state.roster));
        renderTable();
    }).catch(err => {
        console.error('Could not load the team for a scrimmage:', err);
        if (stillOpen(modal)) showPickerMessage('Could not load the roster.');
    });
}

/**
 * Open the Edit Squads dialog for an existing scrimmage — from its card on
 * the team list (with the two halves' summaries) or from inside one of its
 * games (this device's live Game is one half; the other is looked up).
 * @param {object} team - the team as the API lists it, or the local Team
 * @param {string} scrimmageId
 * @param {{summaries?: {X?: object, Y?: object}}} [opts] - the halves as the
 *        game list has them (game_id, team, opponent, …), when known
 */
async function showEditSquadsDialog(team, scrimmageId, { summaries = {} } = {}) {
    if (!team || !scrimmageId) return;
    const modal = openDialog('edit', team);

    try {
        if (!currentTeam || currentTeam.id !== team.id) {
            await selectCloudTeam(team, { landOn: 'none' });
            if (!stillOpen(modal)) return;
        }
        const games = await resolveHalves(scrimmageId, summaries);
        if (!stillOpen(modal)) return;
        if (!games.X && !games.Y) throw new Error('Neither squad\'s game could be loaded.');

        state.edit = { scrimmageId, games };
        state.names = scrimmageSquadNames({ squads: games });
        SQUADS.forEach(squad => {
            const input = modal.querySelector(`#scrimmageSquadName${squad}`);
            if (input) input.value = state.names[squad];
        });
        const labelInput = modal.querySelector('#newScrimmageName');
        if (labelInput) labelInput.value = games.X?.scrimmageName || games.Y?.scrimmageName || '';

        rebuildRoster();
        state.assignment = squadAssignments(games);
        // A player on a squad but not in the pool (removed from the team AND
        // rebuilt by squadRoster) is in the pool as a ghost, so this only
        // drops ids squadRoster could not rebuild (a malformed snapshot entry).
        [...state.assignment.keys()].forEach(id => {
            if (!state.roster.some(p => p.id === id)) state.assignment.delete(id);
        });
        renderTable();
    } catch (err) {
        console.error('Could not load the scrimmage for editing:', err);
        if (stillOpen(modal)) {
            showPickerMessage(`Could not load this scrimmage: ${err.message}`);
            const save = modal.querySelector('#scrimmageSaveBtn');
            if (save) save.disabled = true;
        }
    }
}

/**
 * Both halves of a scrimmage, as fresh as this device can get them: its own
 * live Game for the half it is tracking (the truth here, unsynced edits
 * included), the server's document for the other (a copy this device holds
 * may date from the scrimmage's creation). Half ids come from the card's
 * summaries, the live game, or — from inside a game, where only this half's
 * id is known — the game list.
 * @returns {Promise<{X?: object, Y?: object}>}
 */
async function resolveHalves(scrimmageId, summaries) {
    const live = currentGame();
    const liveHalf = live && live.scrimmageId === scrimmageId && SQUADS.includes(live.scrimmageSquad)
        ? live : null;

    const ids = {};
    SQUADS.forEach(squad => {
        if (summaries?.[squad]?.game_id) ids[squad] = summaries[squad].game_id;
    });
    if (liveHalf) ids[liveHalf.scrimmageSquad] = liveHalf.id;
    if (!ids.X || !ids.Y) {
        const listed = await listServerGames().catch(() => []);
        const [group] = groupScrimmages((listed || []).filter(g => g && g.scrimmageId === scrimmageId));
        SQUADS.forEach(squad => {
            if (!ids[squad] && group?.squads[squad]?.game_id) ids[squad] = group.squads[squad].game_id;
        });
    }

    const games = {};
    for (const squad of SQUADS) {
        if (liveHalf && liveHalf.id === ids[squad]) {
            games[squad] = liveHalf;
            continue;
        }
        const half = ids[squad] ? await loadHalf(ids[squad]) : null;
        if (half) {
            games[squad] = half;
            continue;
        }
        // Not listed yet — the device that just created the scrimmage still
        // has the other half queued for its first sync (a few seconds) — but
        // it holds the copy, and until that sync lands the copy is the truth.
        const local = localHalf(scrimmageId, squad);
        if (local) games[squad] = local;
    }
    return games;
}

/** This device's copy of a scrimmage half, if it holds one. */
function localHalf(scrimmageId, squad) {
    for (const team of teams || []) {
        const game = (team.games || []).find(g =>
            g && g.scrimmageId === scrimmageId && g.scrimmageSquad === squad);
        if (game) return game;
    }
    return null;
}

/** The server's document for a squad-game, else whatever copy this device holds. */
async function loadHalf(gameId) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}`);
        if (response.ok) {
            const doc = await response.json();
            doc.id = gameId;
            return doc;
        }
        log(`Could not fetch squad-game ${gameId}: ${response.status}`);
    } catch (err) {
        log(`Could not fetch squad-game ${gameId} (offline?): ${err.message}`);
    }
    for (const team of teams || []) {
        const local = (team.games || []).find(g => g && g.id === gameId);
        if (local) return local;
    }
    return null;
}

// ── adding a player from the dialog ─────────────────────────────────────

/**
 * The add row: a late arrival joins the roster without the coach leaving the
 * dialog and losing the assignments made so far. The player lands in the
 * list sitting out, highlighted, one tap from a squad — the dialog decides
 * squads, so addPlayerToRoster is told not to put them on the live game's.
 */
function wireAddPlayerRow(modal) {
    const nameInput = modal.querySelector('#scrimmageNewPlayerName');
    const numberInput = modal.querySelector('#scrimmageNewPlayerNumber');
    if (!nameInput || !numberInput) return;

    const add = (gender) => {
        if (!state) return;
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        if (!currentTeam || currentTeam.id !== state.team.id) {
            alert('The roster is still loading — try again in a moment.');
            return;
        }
        const result = addPlayerToRoster({
            name, number: numberInput.value.trim() || null, gender, joinLiveGame: false,
        });
        if (result.error === 'duplicate') {
            alert('A player with this name already exists');
            nameInput.focus();
            return;
        }
        if (result.error === 'number') { numberInput.focus(); return; }
        if (result.error) return;

        nameInput.value = '';
        numberInput.value = '';
        rebuildRoster();
        state.justAdded = result.player.id;
        renderTable();
        log(`🥏 ${result.player.name} added to the roster from the scrimmage dialog`);
        // Rapid entry: straight back to the name for the next one.
        nameInput.focus();
    };

    modal.querySelector('#scrimmageAddFMPBtn')?.addEventListener('click', () => add(Gender.FMP));
    modal.querySelector('#scrimmageAddMMPBtn')?.addEventListener('click', () => add(Gender.MMP));
    // Enter adds with the gender unset, as on the roster screen.
    [nameInput, numberInput].forEach(input => input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); add(Gender.UNKNOWN); }
    }));
}

// ── rendering ───────────────────────────────────────────────────────────

/** The squad names as they will be stored, from the two inputs. */
function effectiveNames() {
    return normalizeSquadNames(state.names);
}

/** Whether a squad has a game to edit (edit mode; a deleted half leaves none). */
function squadHasGame(squad) {
    return !state.edit || !!state.edit.games[squad];
}

/** Squad names appear in the column headers, the pull toggle and the Start / Save buttons. */
function renderNames() {
    if (!state) return;
    const names = effectiveNames();
    const ids = squadIds();
    const modal = state.modal;
    modal.querySelectorAll('th.scrimmage-squad-col').forEach(th => {
        const squad = th.dataset.squad;
        th.textContent = '';
        const name = document.createElement('span');
        name.className = 'scrimmage-col-name';
        name.textContent = names[squad];
        th.appendChild(name);
        const count = document.createElement('span');
        count.className = 'scrimmage-col-count';
        count.textContent = squadHasGame(squad) ? squadSummary(ids[squad]) : 'no game';
        th.appendChild(count);
    });
    modal.querySelectorAll('.scrimmage-pull-btn').forEach(btn => {
        btn.textContent = names[btn.dataset.squad];
        const on = btn.dataset.squad === state.pulling;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.setAttribute('role', 'radio');
    });
    modal.querySelectorAll('.scrimmage-start-btn[data-squad]').forEach(btn => {
        btn.innerHTML = '<i class="fas fa-play"></i> ';
        btn.appendChild(document.createTextNode(`Start, tracking ${names[btn.dataset.squad]}`));
        btn.disabled = state.busy;
    });
    const save = modal.querySelector('#scrimmageSaveBtn');
    if (save) save.disabled = state.busy || !state.edit;
    const sitting = modal.querySelector('#scrimmageSitting');
    if (sitting) {
        const out = state.roster.length - ids.X.length - ids.Y.length;
        sitting.textContent = state.roster.length
            ? (out > 0 ? `${out} sitting out` : 'Everyone is on a squad')
            : '';
    }
}

/** "5 · 3F / 2M" — the header count, with the gender split when known. */
function squadSummary(ids) {
    const players = ids.map(id => state.roster.find(p => p.id === id)).filter(Boolean);
    const fmp = players.filter(p => p.gender === Gender.FMP).length;
    const mmp = players.filter(p => p.gender === Gender.MMP).length;
    let text = String(players.length);
    if (fmp || mmp) text += ` · ${fmp}F / ${mmp}M`;
    return text;
}

/** One row per roster player: name, then a pick button per squad. */
function renderTable() {
    if (!state) return;
    const body = state.modal.querySelector('#scrimmagePickerBody');
    if (!body) return;
    body.innerHTML = '';
    if (state.roster.length === 0) {
        showPickerMessage('No players on the roster yet — add some below, or on Roster + Stats.');
        renderNames();
        return;
    }
    const names = effectiveNames();
    let addedRow = null;
    state.roster.forEach(player => {
        const tr = document.createElement('tr');
        tr.dataset.playerId = player.id;
        const nameTd = document.createElement('td');
        nameTd.className = 'scrimmage-player-col';
        if (player.gender === Gender.FMP) nameTd.classList.add('player-fmp');
        else if (player.gender === Gender.MMP) nameTd.classList.add('player-mmp');
        nameTd.textContent = formatPlayerName(player);
        if (state.ghosts.has(player.id)) {
            // Still on a squad, no longer on the team roster.
            const mark = document.createElement('span');
            mark.className = 'scrimmage-ghost';
            mark.textContent = '(not on roster)';
            nameTd.appendChild(mark);
        } else {
            // Tap the name to fix a typo, a number or a gender on the spot.
            nameTd.classList.add('scrimmage-player-editable');
            nameTd.title = 'Edit player';
            nameTd.addEventListener('click', () => {
                showEditPlayerDialog(player, {
                    onChanged: () => {
                        if (!state) return;
                        rebuildRoster();
                        renderTable();
                    },
                });
            });
        }
        tr.appendChild(nameTd);

        const current = state.assignment.get(player.id) || null;
        SQUADS.forEach(squad => {
            const td = document.createElement('td');
            td.className = 'scrimmage-squad-cell';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'scrimmage-pick';
            btn.dataset.squad = squad;
            const on = current === squad;
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.setAttribute('aria-label', `${player.name} on ${names[squad]}`);
            btn.innerHTML = on ? '<i class="fas fa-check"></i>' : '';
            if (!squadHasGame(squad)) {
                btn.disabled = true;
                btn.title = `${names[squad]} has no game to edit`;
            }
            btn.addEventListener('click', () => {
                // Tap a squad to put the player there; tap it again to sit them out.
                if (state.assignment.get(player.id) === squad) state.assignment.delete(player.id);
                else state.assignment.set(player.id, squad);
                renderTable();
            });
            td.appendChild(btn);
            tr.appendChild(td);
        });
        if (!current) tr.classList.add('scrimmage-sitting-out');
        if (player.id === state.justAdded) {
            tr.classList.add('scrimmage-just-added');
            addedRow = tr;
        }
        body.appendChild(tr);
    });
    state.justAdded = null;
    if (addedRow) addedRow.scrollIntoView({ block: 'nearest' });
    renderNames();
}

// ── starting a scrimmage ────────────────────────────────────────────────

/**
 * Create both squad-games and enter the one this coach will track.
 * @param {'X'|'Y'} trackSquad
 */
function startScrimmage(trackSquad) {
    if (!state || state.busy || !currentTeam) return;
    const ids = squadIds();
    const names = effectiveNames();
    const empty = SQUADS.filter(s => ids[s].length === 0);
    if (empty.length) {
        alert(`Put at least one player on ${empty.map(s => names[s]).join(' and ')} first.`);
        return;
    }
    state.busy = true;
    renderNames();

    try {
        const label = (state.modal.querySelector('#newScrimmageName')?.value || '').trim() || null;
        const games = createSquadGames(currentTeam, {
            names, ids, label, pullingSquad: state.pulling, trackSquad,
        });
        const tracked = games[trackSquad];
        log(`🥏 Scrimmage created: ${names.X} vs ${names.Y} (${tracked.scrimmageId}); tracking ${names[trackSquad]}`);

        closeDialog();

        const timerInput = document.getElementById('pointTimerInput');
        setCountdownSeconds(parseInt(timerInput && timerInput.value, 10) || 90);
        logEvent(`Scrimmage started: ${names[trackSquad]} vs ${names[otherSquad(trackSquad)]}`);

        // late-bound back-edge (game/gameScreenSync lives "above" this layer);
        // see ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
        if (typeof window.enterGameScreen === 'function') window.enterGameScreen();
        if (typeof window.transitionToBetweenPoints === 'function') window.transitionToBetweenPoints();
    } catch (err) {
        console.error('Could not start the scrimmage:', err);
        alert('Could not start the scrimmage: ' + err.message);
        if (state) { state.busy = false; renderNames(); }
    }
}

/**
 * Build, store and sync the two squad-games. The tracked squad's game is
 * pushed last so currentGame() (the tail of team.games) is the one this
 * coach records; the other half is synced explicitly, because saveAllTeamsData
 * syncs only the current game and the other coach needs it on the server.
 *
 * @param {object} team - the local Team (currentTeam)
 * @param {{names: {X: string, Y: string}, ids: {X: string[], Y: string[]},
 *          label: string|null, pullingSquad: 'X'|'Y', trackSquad: 'X'|'Y'}} spec
 * @returns {{X: Game, Y: Game}}
 */
function createSquadGames(team, { names, ids, label, pullingSquad, trackSquad }) {
    const now = new Date();
    const scrimmageId = generateScrimmageId(now);

    // Legacy per-player counters, as startNewGame does before a game.
    team.teamRoster.forEach(player => { player.pointsPlayedPreviousGames = player.totalPointsPlayed; });

    const games = {};
    SQUADS.forEach(squad => {
        // The pulling squad starts on defense, the other on offense.
        const startOn = squad === pullingSquad ? 'defense' : 'offense';
        const game = new Game(names[squad], names[otherSquad(squad)], startOn, team.id);
        Object.assign(game, squadGameFields({ scrimmageId, squad, squadNames: names, name: label }));
        game.gameStartTimestamp = now;
        game.rosterSnapshot = buildSquadSnapshot(team.teamRoster, ids[squad], now);
        // Squads are dealt by the coach, so no ratio rule applies to a squad-game.
        game.alternateGenderRatio = 'No';
        game.alternateGenderPulls = false;
        game.id = generateGameId(game);
        games[squad] = game;
    });

    // A scrimmage is never an event game, whatever screen the coach came from.
    setCurrentEvent(null);

    const other = otherSquad(trackSquad);
    team.games.push(games[other]);
    team.games.push(games[trackSquad]);
    saveAllTeamsData();            // persists both; syncs the current (tracked) game
    syncGameToCloud(games[other]); // the other coach's half must reach the server too
    return games;
}

// ── saving a squad edit ─────────────────────────────────────────────────

/**
 * Write a squad definition onto every copy of a squad-game this device holds
 * and tell the game screen (`breakside:squad-changed`, source 'local'), which
 * prunes the planned lines and redraws when it is the live game. `silent`
 * skips the event: for carrying the server's re-stamp of a definition that
 * was just applied.
 * @returns {boolean} whether a copy was found
 */
function applySquadDefinitionLocally(gameId, definition, { silent = false } = {}) {
    let applied = false;
    (teams || []).forEach(team => (team.games || []).forEach(game => {
        if (!game || game.id !== gameId) return;
        const previous = squadDefinition(game);
        applySquadDefinition(game, definition);
        applied = true;
        if (silent) return;
        document.dispatchEvent(new CustomEvent('breakside:squad-changed', {
            detail: { gameId, previous, current: definition, source: 'local' },
        }));
    }));
    return applied;
}

/**
 * Save the dialog's squads, names and label: a PATCH per changed half (this
 * device's copies first, so the live game's Line tab follows at once), never
 * a full sync — the editing coach's copy of the other half's play data is
 * stale (store/sync.js patchScrimmageGame). Nothing changed: just close.
 */
async function saveSquadEdit() {
    if (!state || state.busy || !state.edit || !currentTeam) return;
    const { games, scrimmageId } = state.edit;
    const ids = squadIds();
    const names = effectiveNames();
    const label = (state.modal.querySelector('#newScrimmageName')?.value || '').trim() || null;

    const empty = SQUADS.filter(s => games[s] && ids[s].length === 0);
    if (empty.length) {
        alert(`Put at least one player on ${empty.map(s => names[s]).join(' and ')}.`);
        return;
    }

    const now = new Date();
    const patches = {};
    SQUADS.forEach(squad => {
        if (!games[squad]) return;
        const players = ids[squad].map(id => state.roster.find(p => p.id === id)).filter(Boolean);
        const patch = squadPatch(games[squad], { players, squadNames: names, label, now });
        if (patch) patches[squad] = patch;
    });
    const changed = SQUADS.filter(s => patches[s]);
    if (!changed.length) {
        closeDialog();
        return;
    }

    state.busy = true;
    renderNames();

    // What this coach's own live game looked like before, for the toast.
    const live = currentGame();
    const liveSquad = changed.find(s => live && games[s].id === live.id) || null;
    const liveBefore = liveSquad ? squadDefinition(games[liveSquad]) : null;
    const pointInProgress = liveSquad ? isPointInProgress() : false;

    const failures = [];
    for (const squad of changed) {
        const gameId = games[squad].id;
        applySquadDefinitionLocally(gameId, patches[squad]);
        try {
            const stored = await patchScrimmageGame(gameId, patches[squad]);
            // The server may have re-stamped the snapshot (a phone whose
            // clock runs behind another coach's); carry its stamp so the next
            // refresh does not read our own edit as somebody else's.
            if (stored && stored.rosterSnapshot) {
                applySquadDefinitionLocally(gameId, squadDefinition(stored), { silent: true });
            }
        } catch (err) {
            console.error(`Could not save ${names[squad]}'s squad:`, err);
            failures.push(`${names[squad]}: ${err.message}`);
        }
    }
    // Persist the copies; the PATCHes carry the change to the server (and the
    // live game's pruned lines already synced from the squad-changed handler).
    saveAllTeamsData({ syncCurrentGame: false });
    log(`🥏 Squads updated (${scrimmageId}): ${changed.map(s => names[s]).join(', ')}`);

    closeDialog();

    if (failures.length) {
        alert(`The squads were saved on this phone, but the server refused: ${failures.join('; ')}`);
    } else {
        const detail = liveSquad
            ? describeSquadChange(liveBefore, patches[liveSquad], { pointInProgress })
            : null;
        const text = detail ? detail.replace(/^Squads updated/, 'Squads saved') : 'Squads saved.';
        showControllerToast(text, 'success', detail && pointInProgress ? 7000 : 3500);
    }
    // The card reads the squad names and label from the game list.
    if (!isGameScreenVisible()) populateCloudTeamsAndGames();
}

export { showNewScrimmageDialog, showEditSquadsDialog, createSquadGames };
