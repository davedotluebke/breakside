/*
 * Intrasquad scrimmage — the New Scrimmage dialog and the creation of the two
 * squad-games. The rules (dealing players, naming, grouping) live in
 * store/scrimmage.js; this file owns the DOM and the Game construction.
 *
 * A scrimmage is two ordinary Games sharing a scrimmageId, one per squad, each
 * from its own squad's side (team = this squad, opponent = the other, roster
 * snapshot = this squad's players). Both are created here, at once, by
 * whichever coach opens the dialog, and both are synced: the other coach then
 * opens the team and taps Track on their squad. Nothing new goes to the
 * server. See ARCHITECTURE.md § Intrasquad scrimmages.
 */
import { Game, Gender } from '../store/models.js';
import { currentTeam, setCurrentEvent, saveAllTeamsData } from '../store/storage.js';
import { syncGameToCloud, generateGameId } from '../store/sync.js';
import {
    SQUADS, DEFAULT_SQUAD_NAMES, normalizeSquadNames, generateScrimmageId,
    squadGameFields, buildSquadSnapshot, splitSquads, otherSquad,
} from '../store/scrimmage.js';
import { formatPlayerName } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { setCountdownSeconds } from '../game/pointManagement.js';
import { selectCloudTeam } from './teamList.js';
import { log } from '../utils/logger.js';

// The open dialog's working state; null when no dialog is open.
let state = null;

/** The team roster in the order the roster screen lists it (by display name). */
function sortedRoster(team) {
    const roster = (team && team.teamRoster) ? team.teamRoster.slice() : [];
    return roster.sort((a, b) =>
        formatPlayerName(a).toLowerCase().localeCompare(formatPlayerName(b).toLowerCase()));
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
 * Open the dialog for a team. The roster comes from the local Team, loading
 * it first when this device has not opened the team yet (the dialog shows a
 * placeholder row meanwhile).
 * @param {object} team - the team as the API lists it
 */
function showNewScrimmageDialog(team) {
    document.getElementById('newScrimmageModal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'newScrimmageModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content event-dialog scrimmage-dialog">
            <div class="dialog-header prominent-dialog-header">
                <h2>New Scrimmage</h2>
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
                    for one squad. Scrimmages stay out of the team's games, events and
                    all-time stats — see <strong>Scrimmages</strong> on the team card.
                </p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => { modal.remove(); state = null; };
    modal.querySelector('.close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };

    state = {
        team,
        roster: [],
        assignment: new Map(),
        names: { ...DEFAULT_SQUAD_NAMES },
        pulling: 'X',
        busy: false,
    };

    // Names and the pull toggle work before the roster lands.
    SQUADS.forEach(squad => {
        const input = document.getElementById(`scrimmageSquadName${squad}`);
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
    document.getElementById('scrimmageShuffleBtn').addEventListener('click', () => {
        // Re-deal only the players who are on a squad — the coach may have
        // taken absentees off first. Nobody on a squad yet: deal everyone.
        const onSquad = state.roster.filter(p => state.assignment.get(p.id));
        applySplit(splitSquads(onSquad.length ? onSquad : state.roster, { shuffle: true }));
        renderTable();
    });
    document.getElementById('scrimmageClearBtn').addEventListener('click', () => {
        state.assignment = new Map();
        renderTable();
    });
    modal.querySelectorAll('.scrimmage-start-btn').forEach(btn => {
        btn.addEventListener('click', () => startScrimmage(btn.dataset.squad));
    });
    renderNames();

    // Make sure the team (and its roster) is in local state, without leaving
    // the team list behind the dialog.
    selectCloudTeam(team, { landOn: 'none' }).then(() => {
        if (!state || state.team !== team) return;   // closed meanwhile
        state.roster = sortedRoster(currentTeam);
        applySplit(splitSquads(state.roster));
        renderTable();
    }).catch(err => {
        console.error('Could not load the team for a scrimmage:', err);
        const body = document.getElementById('scrimmagePickerBody');
        if (body) body.innerHTML = '<tr><td colspan="3" class="scrimmage-loading">Could not load the roster.</td></tr>';
    });
}

/** The squad names as they will be stored, from the two inputs. */
function effectiveNames() {
    return normalizeSquadNames(state.names);
}

/** Squad names appear in the column headers, the pull toggle and the Start buttons. */
function renderNames() {
    if (!state) return;
    const names = effectiveNames();
    const ids = squadIds();
    const modal = document.getElementById('newScrimmageModal');
    if (!modal) return;
    modal.querySelectorAll('th.scrimmage-squad-col').forEach(th => {
        const squad = th.dataset.squad;
        th.textContent = '';
        const name = document.createElement('span');
        name.className = 'scrimmage-col-name';
        name.textContent = names[squad];
        th.appendChild(name);
        const count = document.createElement('span');
        count.className = 'scrimmage-col-count';
        count.textContent = squadSummary(ids[squad]);
        th.appendChild(count);
    });
    modal.querySelectorAll('.scrimmage-pull-btn').forEach(btn => {
        btn.textContent = names[btn.dataset.squad];
        const on = btn.dataset.squad === state.pulling;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.setAttribute('role', 'radio');
    });
    modal.querySelectorAll('.scrimmage-start-btn').forEach(btn => {
        btn.innerHTML = '<i class="fas fa-play"></i> ';
        btn.appendChild(document.createTextNode(`Start, tracking ${names[btn.dataset.squad]}`));
        btn.disabled = state.busy;
    });
    const sitting = document.getElementById('scrimmageSitting');
    if (sitting) {
        const out = state.roster.length - ids.X.length - ids.Y.length;
        sitting.textContent = state.roster.length
            ? (out > 0 ? `${out} sitting out` : 'Everyone is on a squad')
            : '';
    }
}

/** "5 · 3 FMP / 2 MMP" — the header count, with the gender split when known. */
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
    const body = document.getElementById('scrimmagePickerBody');
    if (!body || !state) return;
    body.innerHTML = '';
    if (state.roster.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.className = 'scrimmage-loading';
        td.textContent = 'No players on the roster yet — add some on Roster + Stats first.';
        tr.appendChild(td);
        body.appendChild(tr);
        renderNames();
        return;
    }
    state.roster.forEach(player => {
        const tr = document.createElement('tr');
        tr.dataset.playerId = player.id;
        const nameTd = document.createElement('td');
        nameTd.className = 'scrimmage-player-col';
        if (player.gender === Gender.FMP) nameTd.classList.add('player-fmp');
        else if (player.gender === Gender.MMP) nameTd.classList.add('player-mmp');
        nameTd.textContent = formatPlayerName(player);
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
            btn.setAttribute('aria-label', `${player.name} on ${effectiveNames()[squad]}`);
            btn.innerHTML = on ? '<i class="fas fa-check"></i>' : '';
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
        body.appendChild(tr);
    });
    renderNames();
}

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
        const label = (document.getElementById('newScrimmageName')?.value || '').trim() || null;
        const games = createSquadGames(currentTeam, {
            names, ids, label, pullingSquad: state.pulling, trackSquad,
        });
        const tracked = games[trackSquad];
        log(`🥏 Scrimmage created: ${names.X} vs ${names.Y} (${tracked.scrimmageId}); tracking ${names[trackSquad]}`);

        document.getElementById('newScrimmageModal')?.remove();
        state = null;

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

export { showNewScrimmageDialog, createSquadGames };
