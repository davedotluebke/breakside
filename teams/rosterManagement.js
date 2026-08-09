/*
 * Roster management helpers
 * Handles roster displays and roster-related UI interactions
 * 
 * Phase 4 update: Player IDs, cloud sync for player creation/updates
 */
import { Gender, PlayerPosition, DefaultLine, Player, Role } from '../store/models.js';

// Normalize an edit-dialog toggle value to what we STORE: an explicit
// handler/cutter (or O/D) value, else null. HYBRID and CROSSOVER are the
// "unset" defaults — storing them as null keeps null and hybrid/crossover
// equivalent (matches the Auto resolvers) and avoids spurious dirty state.
function normalizePositionValue(v) {
    return (v === PlayerPosition.HANDLER || v === PlayerPosition.CUTTER) ? v : null;
}
function normalizeDefaultLineValue(v) {
    return (v === DefaultLine.O || v === DefaultLine.D) ? v : null;
}
// Read/write the selected value of an edit-dialog toggle group by data-attr-group.
function getEditPlayerToggleValue(attrGroup) {
    const sel = document.querySelector(
        `#editPlayerDialog .attr-toggle-group[data-attr-group="${attrGroup}"] .attr-toggle-button.selected`);
    return sel ? sel.dataset.value : null;
}
function setEditPlayerToggleValue(attrGroup, value) {
    const group = document.querySelector(
        `#editPlayerDialog .attr-toggle-group[data-attr-group="${attrGroup}"]`);
    if (!group) return;
    group.querySelectorAll('.attr-toggle-button').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.value === value);
    });
}
import { currentTeam, currentEvent, saveAllTeamsData, isViewer } from '../store/storage.js';
import {
    currentGame, formatPlayerName, formatPlayerNameWithRole, formatPlayTime, extractPlayerName,
    isPointInProgress,
} from '../utils/helpers.js';
import {
    getGamePlayerStats, getEventPlayerStats, getTeamPlayerStats,
    accumulateGameStats, getGamesTeamStats, sumPlayerStats,
} from '../utils/eventStats.js';
import {
    StatsLevel, columnsForLevel, getStatsLevel, wireStatsLevelSelect,
} from '../utils/statsLevel.js';
import {
    createPlayerOffline, syncPlayerToCloud, syncTeamToCloud, syncEventToCloud,
    checkForUpdates, syncUserTeams, listServerGames, listTeamEvents,
    loadGameFromCloud,
} from '../store/sync.js';
import {
    buildStatsSheetAoA, aoaToFormattedSheet, downloadWorkbook,
    safeSheetName, safeFilename,
} from '../utils/xlsxExport.js';
import {
    appendRosterCell, buildRosterRow,
    formatSigned, formatSignedFixed, formatPercentOrDash,
} from './rosterRowHelpers.js';
import { showScreen } from '../screens/navigation.js';
import { showSelectTeamScreen } from './teamList.js';
import { initializeGenderRatioDropdown } from '../game/genderRatioDropdown.js';
import { log } from '../utils/logger.js';

// Whether developer debug affordances (e.g. the raw player-ID display in the
// edit-player dialog) should be shown. Off by default in production; enable
// with ?debug=true in the URL or localStorage 'breakside_debug'='true'.
function isDebugEnabled() {
    try {
        if (localStorage.getItem('breakside_debug') === 'true') return true;
    } catch (e) { /* localStorage unavailable */ }
    try {
        return new URLSearchParams(window.location.search).get('debug') === 'true';
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Roster stats scope + sorting state
//
// Scope: 'all' (lifetime, from legacy per-player fields), 'event' (aggregate
// across the current tournament event's games — async cloud load), or 'game'
// (the current game only). Default 'event', falling back when none applies.
// ---------------------------------------------------------------------------
let rosterStatsScope = (function () {
    try { return localStorage.getItem('rosterStatsScope') || 'event'; }
    catch (e) { return 'event'; }
})();
let rosterSortKey = 'name';
let rosterSortDir = 1; // 1 = ascending, -1 = descending
// Cache for the async scopes (event/all); keyed by scope+id so switching scope
// or team invalidates it. Held across scope toggles/sorts within a screen view,
// and cleared on screen (re)entry so newly-played points are picked up.
let _rosterStatsCache = { key: null, byId: {} };
function invalidateRosterStatsCache() {
    _rosterStatsCache = { key: null, byId: {} };
}

// Column descriptors (everything after the checkbox). `num` columns default to
// descending on first click; text columns to ascending. `level` matches the
// Stats menu (see utils/statsLevel.js) — no level means the column always
// shows. Order here is the table order.
// `cell(s, dash)` renders a player row from that player's stats; `total(ctx)`
// renders the Team aggregate row from {totals, detailAvailable, scope, game,
// dash}. Name and F/M carry per-player styling and are built separately.
const ROSTER_COLUMNS = [
    { key: 'name',   label: 'Name', cls: 'roster-name-header',   colCls: 'roster-name-column',   num: false },
    { key: 'gender', label: 'F/M',  cls: 'roster-gender-header', colCls: 'roster-gender-column', num: false },
    {
        key: 'points', label: 'Pts', cls: 'roster-points-header', colCls: 'roster-points-column',
        num: true, level: StatsLevel.BASIC,
        cell: s => s.pointsPlayed || 0,
        // Team points are the game's point count — meaningful only in game scope.
        total: ctx => (ctx.scope === 'game' && ctx.game) ? ctx.game.points.length : ctx.dash
    },
    {
        key: 'time', label: 'Time', cls: 'roster-time-header', colCls: 'roster-time-column',
        num: true, level: StatsLevel.BASIC,
        cell: s => formatPlayTime(s.timePlayed || 0),
        total: ctx => formatPlayTime(ctx.totals.timePlayed)
    },
    {
        key: 'goals', label: 'Goals', cls: 'roster-goals-header', colCls: 'roster-goals-column',
        num: true, level: StatsLevel.BASIC,
        cell: s => s.goals || 0,
        total: ctx => ctx.totals.goals
    },
    {
        key: 'assists', label: 'Assists', cls: 'roster-assists-header', colCls: 'roster-assists-column',
        num: true, level: StatsLevel.BASIC,
        cell: s => s.assists || 0,
        total: ctx => ctx.totals.assists
    },
    {
        key: 'throws', label: 'Throws', cls: 'roster-throws-header', colCls: 'roster-throws-column',
        num: true, level: StatsLevel.FULL,
        cell: (s, dash) => s.totalThrows == null ? dash : s.totalThrows,
        total: ctx => ctx.detailAvailable ? ctx.totals.totalThrows : ctx.dash
    },
    {
        key: 'comppct', label: 'Comp%', cls: 'roster-comppct-header', colCls: 'roster-comppct-column',
        num: true, level: StatsLevel.ADVANCED,
        cell: (s, dash) => s.totalThrows == null ? dash : formatPercentOrDash(s.completions, s.totalThrows),
        total: ctx => (ctx.detailAvailable && ctx.totals.totalThrows > 0)
            ? formatPercentOrDash(ctx.totals.completions, ctx.totals.totalThrows) : ctx.dash
    },
    {
        key: 'dplays', label: 'Ds', cls: 'roster-dplays-header', colCls: 'roster-dplays-column',
        num: true, level: StatsLevel.ADVANCED,
        cell: (s, dash) => s.dPlays == null ? dash : (s.dPlays || 0),
        total: ctx => ctx.detailAvailable ? ctx.totals.dPlays : ctx.dash
    },
    {
        key: 'turnovers', label: 'TOs', cls: 'roster-turnovers-header', colCls: 'roster-turnovers-column',
        num: true, level: StatsLevel.ADVANCED,
        cell: (s, dash) => s.turnovers == null ? dash : (s.turnovers || 0),
        total: ctx => ctx.detailAvailable ? ctx.totals.turnovers : ctx.dash
    },
    {
        key: 'throwaways', label: 'TAs', cls: 'roster-throwaways-header', colCls: 'roster-throwaways-column',
        num: true, level: StatsLevel.FULL,
        cell: (s, dash) => s.throwaways == null ? dash : s.throwaways,
        total: ctx => ctx.detailAvailable ? ctx.totals.throwaways : ctx.dash
    },
    {
        key: 'drops', label: 'Drops', cls: 'roster-drops-header', colCls: 'roster-drops-column',
        num: true, level: StatsLevel.FULL,
        cell: (s, dash) => s.drops == null ? dash : s.drops,
        total: ctx => ctx.detailAvailable ? ctx.totals.drops : ctx.dash
    },
    {
        key: 'plusminus', label: '+/-', cls: 'roster-plusminus-header', colCls: 'roster-plusminus-column',
        num: true, level: StatsLevel.ADVANCED,
        cell: s => formatSigned(s.plusMinus || 0),
        // Team +/- is the scoreline, not the sum of player +/-.
        total: ctx => (ctx.scope === 'game' && ctx.game) ? formatSigned(teamGamePlusMinus(ctx.game)) : ctx.dash
    },
    {
        key: 'perpoint', label: '..per pt', cls: 'roster-plusminus-per-point-header',
        colCls: 'roster-plusminus-per-point-column',
        num: true, level: StatsLevel.ADVANCED,
        cell: s => formatSignedFixed((s.pointsPlayed > 0) ? (s.plusMinus || 0) / s.pointsPlayed : 0, 2),
        total: ctx => {
            if (!(ctx.scope === 'game' && ctx.game)) return ctx.dash;
            const tp = ctx.game.points.length;
            return formatSignedFixed(tp > 0 ? teamGamePlusMinus(ctx.game) / tp : 0, 2);
        }
    },
    {
        key: 'pulls', label: 'Pulls', cls: 'roster-pulls-header', colCls: 'roster-pulls-column',
        num: true, level: StatsLevel.FULL,
        cell: (s, dash) => s.pulls == null ? dash : s.pulls,
        total: ctx => ctx.detailAvailable ? ctx.totals.pulls : ctx.dash
    },
    {
        key: 'pullquality', label: 'G/O/P/B', cls: 'roster-pull-quality-header',
        colCls: 'roster-pull-quality-column',
        num: false, level: StatsLevel.FULL,
        cell: (s, dash) => formatPullQuality(s, dash),
        total: ctx => ctx.detailAvailable ? formatPullQuality(ctx.totals, ctx.dash) : ctx.dash
    }
];

/** Game scoreline as a +/- from the tracking team's perspective. */
function teamGamePlusMinus(game) {
    return (game.scores[Role.TEAM] || 0) - (game.scores[Role.OPPONENT] || 0);
}

/** "3/1/0/1" — good/okay/poor/brick pull counts, or `dash` when none rated. */
function formatPullQuality(s, dash) {
    const rated = (s.pullsGood || 0) + (s.pullsOkay || 0) + (s.pullsPoor || 0) + (s.pullsBrick || 0);
    if (!rated) return dash;
    return `${s.pullsGood || 0}/${s.pullsOkay || 0}/${s.pullsPoor || 0}/${s.pullsBrick || 0}`;
}

function genderLabel(player) {
    if (player.gender === Gender.FMP) return 'FMP';
    if (player.gender === Gender.MMP) return 'MMP';
    return '—';
}

// The scope actually rendered, after falling back when the requested scope has
// no data (no current event / no current game).
function effectiveRosterScope() {
    const hasEvent = typeof currentEvent !== 'undefined' && currentEvent;
    const hasGame = typeof currentGame === 'function' && currentGame();
    if (rosterStatsScope === 'event' && !hasEvent) return hasGame ? 'game' : 'all';
    if (rosterStatsScope === 'game' && !hasGame) return hasEvent ? 'event' : 'all';
    return rosterStatsScope;
}

function updateTeamRosterDisplay() {
    const teamRosterHeader = document.getElementById('teamRosterHeader');
    if (teamRosterHeader) {
        if (currentTeam && currentTeam.name) {
            teamRosterHeader.textContent = `Roster + Stats: ${currentTeam.name}`;
        } else {
            teamRosterHeader.textContent = 'Team Roster + Stats';
        }
    }

    // Hide editing controls for viewers
    const viewerMode = isViewer();
    const rosterScreen = document.getElementById('teamRosterScreen');
    if (rosterScreen) {
        // Hide management rows (add player, create line) and start game subscreen for viewers
        rosterScreen.querySelectorAll('.management-row').forEach(el => {
            el.style.display = viewerMode ? 'none' : '';
        });
        // Only force-hide the Start Game subscreen for viewers. For non-viewers,
        // leave its visibility to the navigation layer (showStartGameSubscreen /
        // showEditRosterSubscreen) — otherwise this re-shows it on top of the
        // Edit Roster screen, defeating the screen separation.
        const startGameSubscreen = document.getElementById('startGameSubscreen');
        if (startGameSubscreen && viewerMode) {
            startGameSubscreen.style.display = 'none';
        }
        // Force roster subscreen visible for viewers
        if (viewerMode) {
            const editRosterSubscreen = document.getElementById('editRosterSubscreen');
            if (editRosterSubscreen) editRosterSubscreen.style.display = '';
        }

        // Add/show a back button for viewers (they can't use the hamburger menu easily)
        let viewerBackBtn = document.getElementById('viewerRosterBackBtn');
        if (viewerMode) {
            if (!viewerBackBtn) {
                viewerBackBtn = document.createElement('button');
                viewerBackBtn.id = 'viewerRosterBackBtn';
                viewerBackBtn.className = 'back-button viewer-roster-back';
                viewerBackBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Back';
                viewerBackBtn.onclick = () => {
                    if (typeof showSelectTeamScreen === 'function') {
                        showSelectTeamScreen();
                    }
                };
                rosterScreen.prepend(viewerBackBtn);
            }
            viewerBackBtn.style.display = '';
        } else if (viewerBackBtn) {
            viewerBackBtn.style.display = 'none';
        }
    }

    // Initialize gender ratio dropdown when roster screen is displayed
    if (typeof initializeGenderRatioDropdown === 'function') {
        initializeGenderRatioDropdown();
    }

    const scope = effectiveRosterScope();
    updateRosterScopeToggleUI(scope);
    wireStatsLevelSelect(document.getElementById('rosterStatsLevel'), () => updateTeamRosterDisplay());

    if (scope === 'game') {
        // Sync: the current game is in memory.
        const byId = (typeof getGamePlayerStats === 'function' && currentGame())
            ? getGamePlayerStats(currentGame()) : {};
        renderRosterTable(scope, byId, false);
        return;
    }

    // Async scopes: 'event' (aggregate the event's games) and 'all' (aggregate
    // every game the team has played) — both derive stats from game events and
    // load games from cloud, so render from cache when fresh, otherwise show a
    // loading state then fill in.
    const key = (scope === 'event')
        ? 'event:' + (currentEvent && currentEvent.id ? currentEvent.id : '')
        : 'all:' + (currentTeam && currentTeam.id ? currentTeam.id : '');

    if (_rosterStatsCache.key === key) {
        renderRosterTable(scope, _rosterStatsCache.byId, false);
        return;
    }

    renderRosterTable(scope, {}, true);
    const statsPromise = (scope === 'event')
        ? (typeof getEventPlayerStats === 'function' ? getEventPlayerStats(currentEvent) : Promise.resolve({}))
        : (typeof getTeamPlayerStats === 'function' ? getTeamPlayerStats(currentTeam) : Promise.resolve({}));
    statsPromise.then(byId => {
        _rosterStatsCache = { key, byId };
        if (effectiveRosterScope() === scope) {
            renderRosterTable(scope, byId, false);
        }
    });
}

/**
 * Render the roster table body for a given scope and stats map.
 * @param {string} scope - 'all' | 'event' | 'game'
 * @param {Object} statsById - playerId → stats (accumulateGameStats shape)
 * @param {boolean} loading - true while async event stats are still loading
 */
function renderRosterTable(scope, statsById, loading) {
    const rosterElement = document.getElementById('rosterList');
    if (!rosterElement) {
        console.warn('Roster list element not found.');
        return;
    }
    rosterElement.innerHTML = '';

    const roster = currentTeam ? currentTeam.teamRoster.slice() : [];
    const visibleColumns = columnsForLevel(ROSTER_COLUMNS);
    // Narrowing the stats level can hide the column being sorted on; fall
    // back to Name rather than sorting by an invisible column.
    if (!visibleColumns.some(col => col.key === rosterSortKey)) {
        rosterSortKey = 'name';
        rosterSortDir = 1;
    }

    // Per-player value accessor used for both sorting and display.
    const valueFor = (player, key) => {
        const s = statsById[player.id] || {};
        switch (key) {
            case 'name': return formatPlayerName(player).toLowerCase();
            case 'gender': return genderLabel(player);
            case 'points': return s.pointsPlayed || 0;
            case 'time': return s.timePlayed || 0;
            case 'goals': return s.goals || 0;
            case 'assists': return s.assists || 0;
            case 'throws': return s.totalThrows == null ? -1 : s.totalThrows;
            case 'comppct':
                if (s.totalThrows == null) return -1; // detail not tracked (all-time)
                return s.totalThrows > 0 ? (s.completions / s.totalThrows) : -1;
            case 'dplays': return s.dPlays == null ? -1 : s.dPlays;
            case 'turnovers': return s.turnovers == null ? -1 : s.turnovers;
            case 'throwaways': return s.throwaways == null ? -1 : s.throwaways;
            case 'drops': return s.drops == null ? -1 : s.drops;
            case 'plusminus': return s.plusMinus || 0;
            case 'perpoint': return (s.pointsPlayed > 0) ? (s.plusMinus || 0) / s.pointsPlayed : 0;
            case 'pulls': return s.pulls == null ? -1 : s.pulls;
            case 'pullquality': return formatPullQuality(s, '');
            default: return 0;
        }
    };

    // Sort a copy of the roster by the active column/direction.
    roster.sort((a, b) => {
        const va = valueFor(a, rosterSortKey);
        const vb = valueFor(b, rosterSortKey);
        let cmp;
        if (typeof va === 'string' || typeof vb === 'string') {
            cmp = String(va).localeCompare(String(vb));
        } else {
            cmp = va - vb;
        }
        if (cmp === 0) {
            // Stable tiebreak by name so order is deterministic
            cmp = formatPlayerName(a).toLowerCase().localeCompare(formatPlayerName(b).toLowerCase());
            return cmp; // tiebreak always ascending
        }
        return cmp * rosterSortDir;
    });

    // --- Header row (sortable) ---
    const headerRow = document.createElement('tr');
    const checkboxHeader = document.createElement('th');
    checkboxHeader.classList.add('roster-header', 'roster-checkbox-header');
    headerRow.appendChild(checkboxHeader);

    visibleColumns.forEach(col => {
        const th = document.createElement('th');
        th.classList.add('roster-header', col.cls, 'roster-sortable');
        let label = col.label;
        if (rosterSortKey === col.key) {
            label += rosterSortDir === 1 ? ' ▲' : ' ▼';
            th.classList.add('roster-sorted');
        }
        th.textContent = label;
        th.addEventListener('click', () => handleRosterHeaderSort(col));
        headerRow.appendChild(th);
    });
    rosterElement.appendChild(headerRow);

    // --- Player rows ---
    const dash = '—';

    roster.forEach(player => {
        const s = statsById[player.id] || {};

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('active-checkbox');

        const nameClasses = ['roster-name-column', 'roster-sticky-name'];
        const genderClasses = ['roster-gender-column'];
        if (player.gender === Gender.FMP) {
            nameClasses.push('player-fmp');
            genderClasses.push('player-fmp');
        } else if (player.gender === Gender.MMP) {
            nameClasses.push('player-mmp');
            genderClasses.push('player-mmp');
        }

        const cells = [{ element: checkbox, className: ['active-checkbox-column', 'roster-sticky-checkbox'] }];
        visibleColumns.forEach(col => {
            if (col.key === 'name') {
                cells.push({
                    value: formatPlayerNameWithRole(player), className: nameClasses,
                    onClick: () => showEditPlayerDialog(player)
                });
            } else if (col.key === 'gender') {
                cells.push({ value: genderLabel(player), className: genderClasses });
            } else {
                cells.push({ value: col.cell(s, dash), className: col.colCls });
            }
        });

        rosterElement.appendChild(buildRosterRow(cells));
    });

    // --- Team aggregate row ---
    // detailAvailable distinguishes "no event data tracked" (legacy all-time
    // stats carry no throw/D detail) from a genuine zero.
    const totals = sumPlayerStats(roster.map(p => statsById[p.id] || {}));
    const detailAvailable = roster.some(p => (statsById[p.id] || {}).totalThrows != null);

    const teamRow = document.createElement('tr');
    teamRow.classList.add('team-aggregate-row');
    const appendTeamCell = (value, className, sticky) => {
        const classes = [className, 'team-total-cell'];
        if (sticky === 'checkbox') classes.push('roster-sticky-checkbox');
        else if (sticky === 'name') classes.push('roster-sticky-name');
        appendRosterCell(teamRow, { value, className: classes });
    };

    const game = (typeof currentGame === 'function') ? currentGame() : null;
    const totalCtx = { totals, detailAvailable, scope, game, dash };
    appendTeamCell('', 'active-checkbox-column', 'checkbox');
    visibleColumns.forEach(col => {
        if (col.key === 'name') appendTeamCell('Team', col.colCls, 'name');
        else if (col.key === 'gender') appendTeamCell('', col.colCls);
        else appendTeamCell(col.total(totalCtx), col.colCls);
    });
    rosterElement.appendChild(teamRow);

    requestAnimationFrame(() => makeRosterColumnsSticky());
}

// Click handler for a sortable column header.
function handleRosterHeaderSort(col) {
    if (rosterSortKey === col.key) {
        rosterSortDir = -rosterSortDir;
    } else {
        rosterSortKey = col.key;
        rosterSortDir = col.num ? -1 : 1; // numbers high-first, text A→Z
    }
    updateTeamRosterDisplay();
}

// Switch the stats scope and re-render.
function setRosterStatsScope(scope) {
    rosterStatsScope = scope;
    try { localStorage.setItem('rosterStatsScope', scope); } catch (e) { /* ignore */ }
    updateTeamRosterDisplay();
}

// Reflect the active scope on the toggle buttons; disable scopes with no data.
function updateRosterScopeToggleUI(effectiveScope) {
    const toggle = document.getElementById('rosterScopeToggle');
    if (!toggle) return;
    const hasEvent = typeof currentEvent !== 'undefined' && currentEvent;
    const hasGame = typeof currentGame === 'function' && currentGame();
    toggle.querySelectorAll('.roster-scope-btn').forEach(btn => {
        const scope = btn.getAttribute('data-scope');
        const disabled = (scope === 'event' && !hasEvent) || (scope === 'game' && !hasGame);
        btn.disabled = disabled;
        btn.style.display = disabled ? 'none' : '';
        btn.classList.toggle('active', scope === effectiveScope);
    });
}

// The game-summary roster table is rendered by teams/gameSummary.js
// (renderGameSummaryStatsTable, id-keyed via getGamePlayerStats). The old
// name-keyed updateGameSummaryRosterDisplay that lived here — the last
// consumer of utils/statistics.js — was dead code and has been removed.

/**
 * Case- and whitespace-insensitive name equality, used by the duplicate-name
 * guards when adding/editing players. Only the *comparison* is normalized —
 * stored names keep the user's original casing/spacing. Without this,
 * "alice" / "Alice " slipped past the exact-match guard and produced two
 * roster entries that render identically but track stats separately.
 */
function playerNamesMatch(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * Validate jersey number input
 * Returns the validated value (string or null), or null if user cancels invalid input
 * Accepts: null/empty, "00", or integers 0-99
 * Shows confirmation alert for invalid values like "pi", "ASDF", "1e23"
 */
function validateJerseyNumber(input) {
    const trimmed = input ? input.trim() : '';
    
    // Empty is valid (no jersey number)
    if (!trimmed) {
        return null;
    }
    
    // Special case: "00" is valid
    if (trimmed === '00') {
        return '00';
    }
    
    // Try to parse as integer
    const parsed = parseInt(trimmed, 10);
    
    // Check if it's a valid integer between 0 and 99
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 99 && parsed.toString() === trimmed) {
        return trimmed;
    }
    
    // Invalid value - ask for confirmation
    const confirmed = confirm(
        `"${trimmed}" is not a valid jersey number (must be 0-99 or 00).\n\n` +
        `Do you want to use "${trimmed}" anyway?`
    );
    
    return confirmed ? trimmed : null;
}

(function setupRosterUI() {
    function addPlayerWithGender(gender) {
        const playerNameInput = document.getElementById('newPlayerInput');
        const playerNumberInput = document.getElementById('newPlayerNumberInput');
        const playerName = playerNameInput ? playerNameInput.value.trim() : '';
        const playerNumber = playerNumberInput ? (playerNumberInput.value.trim() || null) : null;
        
        if (playerName && currentTeam.teamRoster.some(player => playerNamesMatch(player.name, playerName))) {
            alert('A player with this name already exists');
            return;
        }
        if (playerName) {
            const numberValue = validateJerseyNumber(playerNumber);
            // If validation was cancelled (returned null when input was provided), don't add player
            if (playerNumber && numberValue === null) {
                return;
            }
            
            // Phase 4: Create player with ID and queue for cloud sync
            const newPlayer = new Player(playerName, "", gender, numberValue);
            currentTeam.teamRoster.push(newPlayer);
            
            // Add player ID to team's playerIds array
            if (!currentTeam.playerIds) {
                currentTeam.playerIds = [];
            }
            if (!currentTeam.playerIds.includes(newPlayer.id)) {
                currentTeam.playerIds.push(newPlayer.id);
            }
            
            // Queue player for cloud sync
            if (typeof createPlayerOffline === 'function') {
                createPlayerOffline({
                    id: newPlayer.id,
                    name: newPlayer.name,
                    nickname: newPlayer.nickname,
                    gender: newPlayer.gender,
                    number: newPlayer.number,
                    createdAt: newPlayer.createdAt,
                    updatedAt: newPlayer.updatedAt
                });
            }
            
            // Update team on cloud
            if (typeof syncTeamToCloud === 'function' && currentTeam.id) {
                syncTeamToCloud(currentTeam);
            }

            // If a game in progress belongs to a tournament event, the line
            // selector reads from the event roster (getActiveRoster filters
            // team players down to currentEvent.roster.playerIds). A freshly
            // added team player isn't in that list, so they'd stay
            // unselectable for the next line even after a refresh — add them.
            if (typeof currentEvent !== 'undefined' && currentEvent && currentEvent.roster) {
                if (!Array.isArray(currentEvent.roster.playerIds)) {
                    currentEvent.roster.playerIds = [];
                }
                if (!currentEvent.roster.playerIds.includes(newPlayer.id)) {
                    currentEvent.roster.playerIds.push(newPlayer.id);
                    if (typeof syncEventToCloud === 'function') {
                        syncEventToCloud(currentEvent);
                    }
                }
            }

            updateTeamRosterDisplay();

            // If a game is live, refresh the line-selection panel so the new
            // player can be put on the very next line without leaving and
            // re-entering the game.
            // late-bound back-edge (game/selectLine lives "above" this layer);
            // see ARCHITECTURE.md § ES modules — owner keeps the shim.
            if (typeof currentGame === 'function' && currentGame() &&
                typeof window.updateSelectLinePanel === 'function') {
                window.updateSelectLinePanel();
            }

            // Save locally
            if (typeof saveAllTeamsData === 'function') {
                saveAllTeamsData();
            }
        }
        if (playerNameInput) {
            playerNameInput.value = '';
        }
        if (playerNumberInput) {
            playerNumberInput.value = '';
        }
    }
    
    const addFMPPlayerBtn = document.getElementById('addFMPPlayerBtn');
    if (addFMPPlayerBtn) {
        addFMPPlayerBtn.addEventListener('click', () => {
            addPlayerWithGender(Gender.FMP);
        });
    }

    const addMMPPlayerBtn = document.getElementById('addMMPPlayerBtn');
    if (addMMPPlayerBtn) {
        addMMPPlayerBtn.addEventListener('click', () => {
            addPlayerWithGender(Gender.MMP);
        });
    }

    const playerNameInput = document.getElementById('newPlayerInput');
    if (playerNameInput) {
        playerNameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                // Default to UNKNOWN gender if Enter is pressed (user can set later)
                addPlayerWithGender(Gender.UNKNOWN);
            }
        });
    }

    const adjustRosterBtn = document.getElementById('adjustRosterBtn');
    if (adjustRosterBtn) {
        adjustRosterBtn.addEventListener('click', () => {
            updateTeamRosterDisplay();
            showScreen('teamRosterScreen');
            const continueGameBtn = document.getElementById('continueGameBtn');
            if (continueGameBtn) {
                continueGameBtn.classList.remove('inactive');
            }
        });
    }

    const continueGameBtn = document.getElementById('continueGameBtn');
    if (continueGameBtn) {
        continueGameBtn.addEventListener('click', () => {
            if (currentTeam.games.length > 0) {
                // late-bound back-edge (gameScreenSync/gameScreenEvents live
                // "above" this layer); see ARCHITECTURE.md § ES modules — the
                // window shims at the owners are kept deliberately.
                if (typeof window.enterGameScreen === 'function') {
                    window.enterGameScreen();
                    if (isPointInProgress() === false) {
                        if (typeof window.transitionToBetweenPoints === 'function') {
                            window.transitionToBetweenPoints();
                        }
                    }
                    continueGameBtn.classList.add('inactive');
                }
            }
        });
    }

    // Team roster xlsx export — lifetime team stats with one sheet per
    // tournament event plus an "All games" sheet at the front.
    const exportTeamBtn = document.getElementById('exportTeamRosterBtn');
    if (exportTeamBtn) {
        exportTeamBtn.addEventListener('click', exportTeamRosterXLSX);
    }

    // Stats scope toggle (All-time / Event / Game)
    const scopeToggle = document.getElementById('rosterScopeToggle');
    if (scopeToggle) {
        scopeToggle.querySelectorAll('.roster-scope-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const scope = btn.getAttribute('data-scope');
                if (scope) setRosterStatsScope(scope);
            });
        });
    }

    // Line management functions
    const addLineButton = document.querySelector('.add-line-button');
    if (addLineButton) {
        addLineButton.addEventListener('click', addNewLine);
    }

    const deleteLineButton = document.querySelector('.delete-line-button');
    if (deleteLineButton && !deleteLineButton.classList.contains('delete')) {
        deleteLineButton.addEventListener('click', showDeleteLineDialog);
    }
})();

/**
 * Export the current team's roster + lifetime stats to .xlsx.
 * Sheets: "All games" first, then one per TournamentEvent the team has
 * played in (using its full event-level stats), then an "Other" sheet
 * for any games not attached to an event (if any exist).
 */
async function exportTeamRosterXLSX() {
    if (!currentTeam) { alert('No team selected.'); return; }
    const btn = document.getElementById('exportTeamRosterBtn');
    const origHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading…'; }

    try {
        // Roster = current team players (no pickups in the team-level view)
        const players = currentTeam.teamRoster || [];

        // Load all team games (cloud list) and all team events in parallel
        const [allCloudGames, teamEvents] = await Promise.all([
            typeof listServerGames === 'function' ? listServerGames() : [],
            typeof listTeamEvents === 'function' ? listTeamEvents(currentTeam.id) : []
        ]);
        const teamGameList = allCloudGames.filter(g =>
            g.team_id === currentTeam.id || g.teamId === currentTeam.id || g.team === currentTeam.name
        );

        if (teamGameList.length === 0) {
            alert('No games found for this team.');
            return;
        }

        if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Loading 0/${teamGameList.length}…`;

        // Fetch each game in parallel batches of 5 to keep responsive
        const games = [];
        const batchSize = 5;
        for (let i = 0; i < teamGameList.length; i += batchSize) {
            const slice = teamGameList.slice(i, i + batchSize);
            const fetched = await Promise.all(slice.map(async g => {
                try { return await loadGameFromCloud(g.game_id); }
                catch (e) { console.warn('Skip game', g.game_id, e); return null; }
            }));
            fetched.forEach(g => { if (g) games.push(g); });
            if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Loading ${Math.min(i + batchSize, teamGameList.length)}/${teamGameList.length}…`;
        }

        const wb = XLSX.utils.book_new();
        const level = getStatsLevel();   // columns follow the Stats menu

        // Helper: build a sheet from a set of games
        const buildSheet = (sheetGames, label) => {
            const playerStats = {};
            sheetGames.forEach(g => accumulateGameStats(g, playerStats));
            // Shared aggregator rather than a local re-sum — it also carries
            // the per-set breakdown, which a hand-rolled numeric merge drops.
            const teamStats = getGamesTeamStats(sheetGames);
            const titleRow = `${currentTeam.name} — ${label} (${sheetGames.length} game${sheetGames.length === 1 ? '' : 's'})`;
            const aoa = buildStatsSheetAoA(players, playerStats, teamStats, { titleRow, level });
            return aoaToFormattedSheet(aoa);
        };

        // "All games" sheet first
        XLSX.utils.book_append_sheet(wb, buildSheet(games, 'All games'), safeSheetName('All games'));

        // One sheet per event (in the order the server returned them)
        const usedGameIds = new Set();
        for (const ev of teamEvents) {
            const evGameIds = new Set(ev.gameIds || []);
            const evGames = games.filter(g => evGameIds.has(g.id));
            if (evGames.length === 0) continue;
            evGames.forEach(g => usedGameIds.add(g.id));
            XLSX.utils.book_append_sheet(wb, buildSheet(evGames, ev.name), safeSheetName(ev.name));
        }

        // Standalone games (not part of any event)
        const orphans = games.filter(g => !usedGameIds.has(g.id) && !g.eventId);
        if (orphans.length > 0 && orphans.length < games.length) {
            XLSX.utils.book_append_sheet(wb, buildSheet(orphans, 'Standalone games'), safeSheetName('Standalone'));
        }

        downloadWorkbook(wb, `${safeFilename(currentTeam.name)}-stats.xlsx`);
    } catch (e) {
        console.error('Team xlsx export failed:', e);
        alert('Export failed: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
    }
}

/**
 * Function to add a new line
 */
function addNewLine() {
    const lineNameInput = document.querySelector('.line-name-input');
    const lineName = lineNameInput ? lineNameInput.value.trim() : '';
    
    if (!lineName) {
        alert('Please enter a line name');
        return;
    }
    
    // Get selected players
    const selectedPlayers = Array.from(document.querySelectorAll('.active-checkbox:checked'))
        .map(checkbox => {
            const row = checkbox.closest('tr');
            const displayText = row ? row.querySelector('.roster-name-column').textContent : null;
            return displayText ? extractPlayerName(displayText) : null;
        })
        .filter(name => name !== null);
    
    if (selectedPlayers.length === 0) {
        alert('Please select at least one player for the line');
        return;
    }
    
    // Add the new line
    currentTeam.lines.push({
        name: lineName,
        players: selectedPlayers,
        lastUsed: null
    });
    
    // Clear input and save changes
    if (lineNameInput) {
        lineNameInput.value = '';
    }
    saveAllTeamsData();
    updateTeamRosterDisplay();
}

/**
 * Function to show delete line dialog
 */
function showDeleteLineDialog() {
    if (!currentTeam.lines || currentTeam.lines.length === 0) {
        alert('No lines to delete');
        return;
    }
    
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.classList.add('delete-line-overlay');
    
    // Create dialog container
    const dialog = document.createElement('div');
    dialog.classList.add('delete-line-dialog');
    
    const title = document.createElement('h3');
    title.textContent = 'Select Line to Delete';
    dialog.appendChild(title);
    
    // Create container for radio buttons
    const radioContainer = document.createElement('div');
    radioContainer.classList.add('delete-line-radio-container');
    
    currentTeam.lines.forEach((line, index) => {
        const radioDiv = document.createElement('div');
        radioDiv.classList.add('delete-line-radio-option');
        
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'lineToDelete';
        radio.value = index;
        radio.id = `line-${index}`;
        
        const label = document.createElement('label');
        label.htmlFor = `line-${index}`;
        
        const lineName = document.createElement('span');
        lineName.classList.add('line-name');
        lineName.textContent = line.name;
        
        const linePlayers = document.createElement('span');
        linePlayers.classList.add('line-players');
        linePlayers.textContent = line.players.join(', ');
        
        label.appendChild(lineName);
        label.appendChild(linePlayers);
        
        radioDiv.appendChild(radio);
        radioDiv.appendChild(label);
        radioContainer.appendChild(radioDiv);
    });
    
    dialog.appendChild(radioContainer);
    
    const buttonDiv = document.createElement('div');
    buttonDiv.classList.add('delete-line-buttons');
    
    const confirmButton = document.createElement('button');
    confirmButton.textContent = 'Delete';
    confirmButton.classList.add('delete-line-button', 'delete');
    confirmButton.disabled = true; // Initially disabled
    
    // Add event listener to radio buttons to enable/disable delete button
    const radioButtons = dialog.querySelectorAll('input[type="radio"]');
    radioButtons.forEach(radio => {
        radio.addEventListener('change', () => {
            confirmButton.disabled = false;
        });
    });
    
    confirmButton.addEventListener('click', () => {
        const selectedRadio = dialog.querySelector('input[name="lineToDelete"]:checked');
        if (selectedRadio) {
            const index = parseInt(selectedRadio.value);
            currentTeam.lines.splice(index, 1);
            saveAllTeamsData();
            updateTeamRosterDisplay();
        }
        document.body.removeChild(overlay);
    });
    
    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.classList.add('delete-line-button', 'cancel');
    cancelButton.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });
    
    buttonDiv.appendChild(cancelButton);
    buttonDiv.appendChild(confirmButton);
    dialog.appendChild(buttonDiv);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// Edit Player Dialog state
let editPlayerDialogPlayer = null;
let editPlayerDialogPlayerId = null;  // Store ID separately to handle roster refreshes
let editPlayerDialogOriginalData = null;
let editPlayerDialogContext = {};  // Options for pickup context (onSave, onDelete callbacks)

/**
 * Show the edit player dialog for a given player
 */
function showEditPlayerDialog(player, options = {}) {
    if (!player) {
        console.error('Cannot show edit player dialog: no player provided');
        return;
    }

    editPlayerDialogPlayer = player;
    editPlayerDialogPlayerId = player.id;  // Store ID for reliable comparison
    editPlayerDialogContext = options;
    const isEventOverride = options.context === 'eventOverride';
    // Store original values to detect changes. In event-override mode we only
    // edit position/line (as an override), so the "original" is the current
    // override state; position/line default to the inherited values for display.
    editPlayerDialogOriginalData = {
        name: player.name,
        number: player.number,
        gender: player.gender,
        // Override values are stored RAW (hybrid/crossover kept, not nulled) so
        // an override can force flex even when the base player is labeled.
        position: isEventOverride ? (options.overridePosition || null) : normalizePositionValue(player.position),
        defaultLine: isEventOverride ? (options.overrideDefaultLine || null) : normalizeDefaultLineValue(player.defaultLine),
        hasOverride: isEventOverride ? !!options.hasOverride : false
    };

    const dialog = document.getElementById('editPlayerDialog');
    if (!dialog) {
        console.error('Edit player dialog element not found');
        return;
    }

    // Populate form fields with current player data
    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');
    const confirmBtn = document.getElementById('editPlayerConfirmBtn');

    if (nameInput) nameInput.value = player.name;
    if (numberInput) numberInput.value = player.number || '';
    
    // Player ID display — a debugging affordance, gated off in production.
    // Enable with ?debug=true in the URL or localStorage 'breakside_debug'='true'.
    let playerIdDisplay = document.getElementById('editPlayerIdDisplay');
    if (isDebugEnabled()) {
        if (!playerIdDisplay) {
            // Create the ID display element if it doesn't exist. Build the label
            // statically and set the id via textContent (never interpolate the
            // user-derived player.id into innerHTML).
            const container = dialog.querySelector('.edit-player-container');
            if (container) {
                const idField = document.createElement('div');
                idField.className = 'edit-player-field edit-player-id-field';
                const label = document.createElement('label');
                label.textContent = 'Player ID:';
                const code = document.createElement('code');
                code.id = 'editPlayerIdDisplay';
                code.className = 'player-id-code';
                code.textContent = player.id || 'No ID';
                idField.appendChild(label);
                idField.appendChild(code);
                container.insertBefore(idField, container.firstChild);
                playerIdDisplay = code;
            }
        } else {
            playerIdDisplay.textContent = player.id || 'No ID';
        }
    }

    // Hide player ID display for pickup context (or entirely when not debugging)
    const idField = playerIdDisplay ? playerIdDisplay.closest('.edit-player-id-field') : null;
    if (idField) {
        idField.style.display = (!isDebugEnabled() || options.context === 'pickup') ? 'none' : '';
    }

    // Set gender button states
    if (fmpBtn && mmpBtn) {
        fmpBtn.classList.remove('selected');
        mmpBtn.classList.remove('selected');
        if (player.gender === Gender.FMP) {
            fmpBtn.classList.add('selected');
        } else if (player.gender === Gender.MMP) {
            mmpBtn.classList.add('selected');
        }
    }

    // Position / default-line toggles. Unset resolves to Hybrid / Crossover,
    // so one option is always shown selected. In event-override mode the
    // displayed values come from the override (falling back to the inherited
    // effective values passed in options) rather than the base player.
    const showPos = isEventOverride
        ? (options.overridePosition || options.inheritedPosition || PlayerPosition.HYBRID)
        : (player.position || PlayerPosition.HYBRID);
    const showLine = isEventOverride
        ? (options.overrideDefaultLine || options.inheritedDefaultLine || DefaultLine.CROSSOVER)
        : (player.defaultLine || DefaultLine.CROSSOVER);
    setEditPlayerToggleValue('position', showPos);
    setEditPlayerToggleValue('line', showLine);

    // Apply dialog mode (event-override hides identity fields, shows the
    // inherit/override checkbox) and gate the toggles accordingly.
    applyEditPlayerDialogMode(isEventOverride, editPlayerDialogOriginalData.hasOverride);

    // Reset confirm button state
    if (confirmBtn) {
        confirmBtn.disabled = true;
    }

    // Show dialog
    dialog.style.display = 'block';
}

/**
 * Toggle the edit-player dialog between full edit and event-override modes.
 * Event-override mode hides the identity fields (name/number/gender) and the
 * delete button, reveals the inherit/override checkbox, and enables the
 * position/line toggles only when overriding.
 * @param {boolean} isEventOverride
 * @param {boolean} hasOverride - whether an override currently exists
 */
function applyEditPlayerDialogMode(isEventOverride, hasOverride) {
    const nameField = document.getElementById('editPlayerName')?.closest('.edit-player-field');
    const numberField = document.getElementById('editPlayerNumber')?.closest('.edit-player-field');
    const genderField = document.querySelector('#editPlayerDialog .edit-player-gender-field');
    const overrideField = document.getElementById('editPlayerOverrideField');
    const overrideToggle = document.getElementById('editPlayerOverrideToggle');
    const deleteBtn = document.getElementById('editPlayerDeleteBtn');
    const title = document.querySelector('#editPlayerDialog .dialog-header h2');

    const idHide = isEventOverride ? 'none' : '';
    if (nameField) nameField.style.display = idHide;
    if (numberField) numberField.style.display = idHide;
    if (genderField) genderField.style.display = idHide;
    if (deleteBtn) deleteBtn.style.display = idHide;
    if (overrideField) overrideField.style.display = isEventOverride ? '' : 'none';
    if (title) title.textContent = isEventOverride ? 'Event Position / Line' : 'Edit Player';

    if (isEventOverride && overrideToggle) {
        overrideToggle.checked = !!hasOverride;
    }
    setEditPlayerToggleGroupsEnabled(!isEventOverride || !!hasOverride);
}

/**
 * Enable/disable (grey out) the position and line toggle groups — used in
 * event-override mode so the toggles are inert while inheriting.
 * @param {boolean} enabled
 */
function setEditPlayerToggleGroupsEnabled(enabled) {
    document.querySelectorAll('#editPlayerDialog .attr-toggle-group').forEach(group => {
        group.classList.toggle('attr-toggle-group--disabled', !enabled);
        group.querySelectorAll('.attr-toggle-button').forEach(btn => { btn.disabled = !enabled; });
    });
}

/**
 * Close the edit player dialog
 */
function closeEditPlayerDialog() {
    const dialog = document.getElementById('editPlayerDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
    editPlayerDialogPlayer = null;
    editPlayerDialogPlayerId = null;
    editPlayerDialogOriginalData = null;
    editPlayerDialogContext = {};
}

/**
 * Check if any changes have been made and update confirm button state
 */
function updateEditPlayerDialogState() {
    if (!editPlayerDialogPlayer || !editPlayerDialogOriginalData) {
        return;
    }

    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');
    const confirmBtn = document.getElementById('editPlayerConfirmBtn');

    if (!nameInput || !confirmBtn) {
        return;
    }

    // Event-override mode: only the override checkbox + position/line matter.
    if (editPlayerDialogContext.context === 'eventOverride') {
        const overriding = !!document.getElementById('editPlayerOverrideToggle')?.checked;
        // Raw values (hybrid/crossover preserved) — see originalData note.
        const curPos = overriding ? (getEditPlayerToggleValue('position') || null) : null;
        const curLine = overriding ? (getEditPlayerToggleValue('line') || null) : null;
        const orig = editPlayerDialogOriginalData;
        const changed = (overriding !== orig.hasOverride)
            || (overriding && (curPos !== orig.position || curLine !== orig.defaultLine));
        confirmBtn.disabled = !changed;
        return;
    }

    // Get current form values
    const currentName = nameInput.value.trim();
    const currentNumber = numberInput.value.trim();
    const currentNumberValue = currentNumber || null;
    
    // Determine current gender selection
    let currentGender = Gender.UNKNOWN;
    if (fmpBtn && fmpBtn.classList.contains('selected')) {
        currentGender = Gender.FMP;
    } else if (mmpBtn && mmpBtn.classList.contains('selected')) {
        currentGender = Gender.MMP;
    }

    // Current position / default-line selections (normalized: hybrid/crossover => null)
    const currentPosition = normalizePositionValue(getEditPlayerToggleValue('position'));
    const currentDefaultLine = normalizeDefaultLineValue(getEditPlayerToggleValue('line'));

    // Check if any changes were made
    const nameChanged = currentName !== editPlayerDialogOriginalData.name;
    const numberChanged = currentNumberValue !== editPlayerDialogOriginalData.number;
    const genderChanged = currentGender !== editPlayerDialogOriginalData.gender;
    const positionChanged = currentPosition !== editPlayerDialogOriginalData.position;
    const lineChanged = currentDefaultLine !== editPlayerDialogOriginalData.defaultLine;

    // Enable confirm button if changes were made and name is not empty
    confirmBtn.disabled =
        !(nameChanged || numberChanged || genderChanged || positionChanged || lineChanged)
        || currentName === '';
}

/**
 * Delete the current player with confirmation
 */
function deletePlayer() {
    if (!editPlayerDialogPlayerId) {
        console.error('Cannot delete player: no player ID');
        return;
    }

    // Pickup context: delegate to callback
    if (editPlayerDialogContext.context === 'pickup' && editPlayerDialogContext.onDelete) {
        const playerName = editPlayerDialogPlayer ? editPlayerDialogPlayer.name : 'this player';
        if (!confirm(`Are you sure you want to remove ${playerName}?`)) return;
        editPlayerDialogContext.onDelete();
        return;
    }

    // Get the current player from roster by ID (handles roster refresh)
    const player = currentTeam.teamRoster.find(p => p.id === editPlayerDialogPlayerId);
    if (!player) {
        console.error('Cannot delete player: player not found in roster');
        alert('Error: Player not found. The roster may have been updated.');
        closeEditPlayerDialog();
        return;
    }

    const playerName = player.name;

    // Show confirmation alert
    if (!confirm(`Are you sure you want to delete ${playerName}?`)) {
        return; // User cancelled
    }

    // Get player ID before removing
    const playerId = editPlayerDialogPlayerId;

    // Remove player from roster by ID
    const index = currentTeam.teamRoster.findIndex(p => p.id === playerId);
    if (index > -1) {
        currentTeam.teamRoster.splice(index, 1);
    }

    // Remove player ID from team's playerIds array
    if (currentTeam.playerIds && playerId) {
        const idIndex = currentTeam.playerIds.indexOf(playerId);
        if (idIndex > -1) {
            currentTeam.playerIds.splice(idIndex, 1);
        }
    }

    // Phase 4: Sync team update to cloud (player removed from team)
    // Note: We don't delete the player entity itself - they may be on other teams
    if (typeof syncTeamToCloud === 'function' && currentTeam.id) {
        syncTeamToCloud(currentTeam);
    }

    // Save changes
    saveAllTeamsData();

    // Refresh roster display
    updateTeamRosterDisplay();

    // Close dialog
    closeEditPlayerDialog();
}

/**
 * Save the edited player data
 */
function saveEditedPlayer() {
    if (!editPlayerDialogPlayerId || !editPlayerDialogOriginalData) {
        console.error('Cannot save edited player: no player ID or original data');
        return;
    }

    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');

    if (!nameInput) {
        console.error('Cannot save edited player: name input not found');
        return;
    }

    const newName = nameInput.value.trim();
    if (!newName) {
        alert('Player name cannot be empty');
        return;
    }

    // Get new values
    const newNumber = numberInput.value.trim();
    const newNumberValue = validateJerseyNumber(newNumber);

    // If validation was cancelled (returned null when input was provided), don't save
    if (newNumber && newNumberValue === null) {
        return;
    }

    // Determine new gender
    let newGender = Gender.UNKNOWN;
    if (fmpBtn && fmpBtn.classList.contains('selected')) {
        newGender = Gender.FMP;
    } else if (mmpBtn && mmpBtn.classList.contains('selected')) {
        newGender = Gender.MMP;
    }

    // Position / default-line (normalized: hybrid/crossover => null)
    const newPosition = normalizePositionValue(getEditPlayerToggleValue('position'));
    const newDefaultLine = normalizeDefaultLineValue(getEditPlayerToggleValue('line'));

    // Event-override context: only write the override (position/line), or clear
    // it when the coach unchecks "override". Never touches the base player.
    if (editPlayerDialogContext.context === 'eventOverride' && editPlayerDialogContext.onSave) {
        const overriding = !!document.getElementById('editPlayerOverrideToggle')?.checked;
        editPlayerDialogContext.onSave(overriding
            ? {
                override: true,
                // Raw toggle values so an override can force hybrid/crossover.
                position: getEditPlayerToggleValue('position'),
                defaultLine: getEditPlayerToggleValue('line')
            }
            : { override: false });
        closeEditPlayerDialog();
        return;
    }

    // Pickup context: delegate to callback
    if (editPlayerDialogContext.context === 'pickup' && editPlayerDialogContext.onSave) {
        editPlayerDialogContext.onSave({
            name: newName, number: newNumberValue, gender: newGender,
            position: newPosition, defaultLine: newDefaultLine
        });
        closeEditPlayerDialog();
        return;
    }

    // Get the current player from roster by ID (handles roster refresh during edit)
    const player = currentTeam.teamRoster.find(p => p.id === editPlayerDialogPlayerId);
    if (!player) {
        console.error('Cannot save edited player: player not found in roster');
        alert('Error: Player not found. The roster may have been updated. Please try again.');
        closeEditPlayerDialog();
        return;
    }

    // Check if name already exists (excluding current player).
    // Normalized comparison: trim + case-fold, so "alice " no longer slips
    // past the guard as distinct from "Alice".
    const nameExists = currentTeam.teamRoster.some(p =>
        p.id !== editPlayerDialogPlayerId && playerNamesMatch(p.name, newName)
    );
    if (nameExists) {
        alert('A player with this name already exists');
        return;
    }

    // Update player object (using fresh reference from roster)
    player.name = newName;
    player.number = newNumberValue;
    player.gender = newGender;
    player.position = newPosition;
    player.defaultLine = newDefaultLine;
    player.updatedAt = new Date().toISOString();

    // Phase 4: Sync player update to cloud
    if (typeof syncPlayerToCloud === 'function') {
        syncPlayerToCloud(player);
    }

    // Save changes
    saveAllTeamsData();

    // Refresh roster display
    updateTeamRosterDisplay();

    // Close dialog
    closeEditPlayerDialog();
}

// Initialize edit player dialog event handlers
(function initializeEditPlayerDialog() {
    const dialog = document.getElementById('editPlayerDialog');
    if (!dialog) {
        console.warn('Edit player dialog not found, skipping initialization');
        return;
    }

    // Close button
    const closeBtn = dialog.querySelector('.close');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeEditPlayerDialog);
    }

    // Close when clicking outside dialog
    window.addEventListener('click', function(event) {
        if (event.target === dialog) {
            closeEditPlayerDialog();
        }
    });

    // Cancel button
    const cancelBtn = document.getElementById('editPlayerCancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeEditPlayerDialog);
    }

    // Confirm button
    const confirmBtn = document.getElementById('editPlayerConfirmBtn');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', saveEditedPlayer);
    }

    // Delete button
    const deleteBtn = document.getElementById('editPlayerDeleteBtn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deletePlayer);
    }

    // Gender buttons
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');
    
    if (fmpBtn) {
        fmpBtn.addEventListener('click', function() {
            // Toggle selection
            if (this.classList.contains('selected')) {
                this.classList.remove('selected');
            } else {
                this.classList.add('selected');
                if (mmpBtn) mmpBtn.classList.remove('selected');
            }
            updateEditPlayerDialogState();
        });
    }

    if (mmpBtn) {
        mmpBtn.addEventListener('click', function() {
            // Toggle selection
            if (this.classList.contains('selected')) {
                this.classList.remove('selected');
            } else {
                this.classList.add('selected');
                if (fmpBtn) fmpBtn.classList.remove('selected');
            }
            updateEditPlayerDialogState();
        });
    }

    // Position / default-line toggle groups: one selection each (no deselect —
    // hybrid/crossover is a real option, so a value is always chosen).
    document.querySelectorAll('#editPlayerDialog .attr-toggle-group').forEach(group => {
        group.addEventListener('click', function(event) {
            const btn = event.target.closest('.attr-toggle-button');
            if (!btn || !this.contains(btn) || btn.disabled) return;
            this.querySelectorAll('.attr-toggle-button').forEach(b => {
                b.classList.toggle('selected', b === btn);
            });
            updateEditPlayerDialogState();
        });
    });

    // Event-override inherit/override checkbox: enables the toggles when set.
    const overrideToggle = document.getElementById('editPlayerOverrideToggle');
    if (overrideToggle) {
        overrideToggle.addEventListener('change', function() {
            setEditPlayerToggleGroupsEnabled(this.checked);
            updateEditPlayerDialogState();
        });
    }

    // Input fields - track changes
    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    
    if (nameInput) {
        nameInput.addEventListener('input', updateEditPlayerDialogState);
        nameInput.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !confirmBtn.disabled) {
                saveEditedPlayer();
            }
        });
    }
    
    if (numberInput) {
        numberInput.addEventListener('input', updateEditPlayerDialogState);
    }
})();

/**
 * Make the first two columns (checkbox, name) sticky for horizontal scrolling
 */
// Sticky positioning, colors, borders, and z-index for the checkbox/name
// columns live in CSS (see .roster-sticky-checkbox / .roster-sticky-name /
// .roster-checkbox-header / .roster-name-header in css/tables.css). This only
// width-syncs the checkbox column and offsets the name column's `left` to
// sit right after it — the one part CSS can't do on its own, since the
// checkbox column's rendered width isn't a fixed constant across
// browsers/zoom levels. Called once per render, after all rows are built.
function makeRosterColumnsSticky() {
    const checkboxCells = document.querySelectorAll('.roster-sticky-checkbox');
    if (checkboxCells.length === 0) {
        return;
    }

    // Get checkbox column width - use getBoundingClientRect which includes padding and border
    // Use the first data cell (not header) for accurate measurement
    const firstCheckboxCell = checkboxCells[0];
    const checkboxRect = firstCheckboxCell.getBoundingClientRect();
    let checkboxCellWidth = checkboxRect.width;

    // If width is 0 or invalid, try to get computed style width
    if (checkboxCellWidth <= 0) {
        const computedStyle = window.getComputedStyle(firstCheckboxCell);
        checkboxCellWidth = parseFloat(computedStyle.width) || 30; // fallback to 30px
    }

    // Force consistent width across all checkbox cells (data + header)
    const applyCheckboxWidth = (cell) => {
        cell.style.width = `${checkboxCellWidth}px`;
        cell.style.minWidth = `${checkboxCellWidth}px`;
        cell.style.maxWidth = `${checkboxCellWidth}px`;
        cell.style.boxSizing = 'border-box';
    };
    checkboxCells.forEach(applyCheckboxWidth);
    const headerCheckbox = document.querySelector('.roster-checkbox-header');
    if (headerCheckbox) applyCheckboxWidth(headerCheckbox);

    // Offset the name column (data + header) to sit right after the checkbox column
    document.querySelectorAll('.roster-sticky-name').forEach(cell => {
        cell.style.left = `${checkboxCellWidth}px`;
    });
    const headerName = document.querySelector('.roster-name-header');
    if (headerName) {
        headerName.style.left = `${checkboxCellWidth}px`;
    }
}

// =============================================================================
// Roster Screen Polling (for cross-device sync)
// =============================================================================

let rosterPollIntervalId = null;
const ROSTER_POLL_INTERVAL = 10000;  // 10 seconds

/**
 * Start polling for roster updates while on the roster screen
 */
function startRosterPolling() {
    if (rosterPollIntervalId) {
        return; // Already running
    }
    
    rosterPollIntervalId = setInterval(async () => {
        // Only poll if we're on the roster screen
        const rosterScreen = document.getElementById('teamRosterScreen');
        if (!rosterScreen || rosterScreen.style.display === 'none') {
            stopRosterPolling();
            return;
        }
        
        // Check if we're authenticated and online
        if (!window.breakside?.auth?.isAuthenticated?.() || !navigator.onLine) {
            return;
        }
        
        // Don't poll during active game
        if (typeof currentGame === 'function') {
            try {
                const game = currentGame();
                if (game && !game.gameEndTimestamp) {
                    return;
                }
            } catch (e) {
                // No current game
            }
        }
        
        try {
            // Check for updates
            if (typeof checkForUpdates === 'function') {
                const hasUpdates = await checkForUpdates();
                
                if (hasUpdates && typeof syncUserTeams === 'function') {
                    log('📥 Roster: Updates detected, syncing...');
                    const result = await syncUserTeams();
                    
                    // Always refresh roster display after sync completes
                    // The sync may have updated player attributes even if counts didn't change
                    if (result.success) {
                        if (typeof updateTeamRosterDisplay === 'function') {
                            updateTeamRosterDisplay();
                        }
                        log('✅ Roster: Refreshed display after sync');
                    }
                }
            }
        } catch (error) {
            console.warn('Roster poll failed:', error);
        }
    }, (window.advancedSettings?.getRefreshIntervalMs?.() || ROSTER_POLL_INTERVAL));
    
    log('🔄 Started roster polling');
}

/**
 * Stop roster polling
 */
function stopRosterPolling() {
    if (rosterPollIntervalId) {
        clearInterval(rosterPollIntervalId);
        rosterPollIntervalId = null;
        log('⏹️ Stopped roster polling');
    }
}

// Start polling when roster screen becomes visible
// React to navigation via the module-era hook (replaces the old
// window.showScreen wrapper, which broke once navigation.js became a module).
document.addEventListener('breakside:screen-shown', (e) => {
    if (e.detail.screenId === 'teamRosterScreen') {
        startRosterPolling();
    } else {
        stopRosterPolling();
    }
});

// --- ES-module exports ---
export {
    updateTeamRosterDisplay, invalidateRosterStatsCache,
    showEditPlayerDialog, closeEditPlayerDialog, validateJerseyNumber,
};
// window survivor: late-bound back-edge hook (called by store/sync.js,
// screens/navigation.js — both evaluate before this file and cannot import
// from it without a cycle/reorder)
window.updateTeamRosterDisplay = updateTeamRosterDisplay;
// window survivor: late-bound back-edge hook (called by screens/navigation.js)
window.invalidateRosterStatsCache = invalidateRosterStatsCache;

