/*
 * Game screen — Select-Line panel & auto-line logic.
 * Line selection tables, O/D toggle, auto-line, gender-ratio, line-edit conflict,
 * and the effective-line resolution for the next point.
 * Split from the former monolithic gameScreen.js (refactor, no behavior change).
 */
import { Gender } from '../store/models.js';
import { currentTeam, currentEvent, getActiveRoster, saveAllTeamsData } from '../store/storage.js';
import {
    currentGame, isPointInProgress, determineStartingPosition,
    getPlayerGameTime, formatPlayTime, formatPlayerName,
    getGenderRatioForPoint, getExpectedGenderRatio, getExpectedGenderCounts,
} from '../utils/helpers.js';
import { getEventPlayerStats } from '../utils/eventStats.js';
import { clearNextLineSelections, getRunningScores } from '../ui/activePlayersDisplay.js';
import { setPanelSubtitle, setPanelTitle, isGameScreenVisible } from '../ui/panelSystem.js';
import { getControllerState, showControllerToast } from './controllerState.js';
import { startNextPoint } from './pointManagement.js';
import { WHOLESALE_ICON_SVG, noteLineCoachViewing } from './gameScreenPanels.js';
import {
    canEditPlayByPlayPanel, updatePlayByPlayPanelState,
    updateSubPlayersCount, handleLineupReadyTap,
} from './gameScreenEvents.js';

// =============================================================================
// Select Next Line Panel
// =============================================================================

// Track stats display mode for panel (Game vs Total vs Event)
let panelShowingTotalStats = false;
let panelStatsMode = 'game'; // 'game', 'event', or 'total'
// Event-aggregated stats for the panel's 'event' mode. getEventPlayerStats()
// is async (it loads every event game from the cloud), so it's fetched once
// when 'event' mode is entered and cached here; the synchronous table
// renderers read this cache rather than calling the async function inline.
let cachedPanelEventStats = null;

// Track conflict detection state
let lastConflictToastPointIndex = -1;  // Prevent multiple toasts per point
let lastGameUpdatedToastTime = 0;  // Throttle game-updated toasts
let localLineEditTimestamps = {
    oLine: 0,
    dLine: 0,
    odLine: 0
};

/**
 * Wire up Select Next Line panel event handlers
 */
function wireSelectLineEvents() {
    // Auto action button (Wholesale + the Game/Event toggle now live in the
    // table's controls header row — see buildSelectLineControlsRow + the
    // delegated click handler wired on the table container below).
    const autoBtn = document.getElementById('panelAutoBtn');
    if (autoBtn) {
        autoBtn.addEventListener('click', () => autoFillLineSelection('main'));
    }

    // Keep the toolbar from overflowing as width changes (orientation, split
    // views, gender badge appearing): drop the Auto label if needed.
    setupLineToolbarResponsive();

    // (Wholesale icon + Game/Event stats toggle now live in the table's controls
    // header row — clicks handled via delegation on the table container below.)

    // Combined/Separate planning-mode toggle pill
    const lineModeBtn = document.getElementById('panelLineModeBtn');
    if (lineModeBtn) {
        lineModeBtn.addEventListener('click', toggleLineModeMenu);
    }

    // Line-type toggle button. In Combined mode it flips Next ↔ On Deck; in
    // Separate mode it flips O line ↔ D line.
    const odToggle = document.getElementById('panelODToggle');
    if (odToggle) {
        odToggle.addEventListener('click', handleODToggle);
    }
    
    // Lines button
    const linesBtn = document.getElementById('panelLinesBtn');
    if (linesBtn) {
        linesBtn.addEventListener('click', handlePanelLinesClick);
    }

    // Line-tab Start Point button. Visible only when the Line tab is the
    // active tab (so it doesn't clutter the All view, which already shows
    // the PBP panel's own Start Point button) and the user has the Active
    // Coach role. Reuses the same handler as the PBP panel's button.
    const lineTabStartPointBtn = document.getElementById('lineTabStartPointBtn');
    if (lineTabStartPointBtn) {
        lineTabStartPointBtn.addEventListener('click', handlePanelStartPoint);
    }

    // Line-tab "Lineup Ready" button. Multi-coach signal — Line Coach
    // pings Active Coach that the next line is set. See
    // handleLineupReadyTap for the cross-coach state flow.
    const lineTabLineupReadyBtn = document.getElementById('lineTabLineupReadyBtn');
    if (lineTabLineupReadyBtn) {
        lineTabLineupReadyBtn.addEventListener('click', handleLineupReadyTap);
    }
    
    // Player table checkbox changes (delegated)
    const tableContainer = document.getElementById('panelTableContainer');
    if (tableContainer) {
        tableContainer.addEventListener('change', handlePanelCheckboxChange);
        // Delegated clicks for the controls header row (Wholesale icon and the
        // Game/Event stats toggle), which are rebuilt with the table each refresh.
        tableContainer.addEventListener('click', (e) => {
            if (e.target.closest('.select-line-th-stats')) { handlePanelStatsToggle(); return; }
            if (e.target.closest('.select-line-th-wholesale')) { clearLineSelection('main'); return; }
        });
    }
    
    // Starting gender ratio radio buttons
    const fmpRadio = document.getElementById('panelStartingRatioFMP');
    const mmpRadio = document.getElementById('panelStartingRatioMMP');
    if (fmpRadio) {
        fmpRadio.addEventListener('change', handlePanelStartingRatioChange);
    }
    if (mmpRadio) {
        mmpRadio.addEventListener('change', handlePanelStartingRatioChange);
    }
}

/**
 * Handle stats toggle click — cycles through Game → Event → (skip Total when in event)
 * or Game ↔ Total when no event
 */
function handlePanelStatsToggle() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const inEvent = game && game.eventId && currentEvent;

    if (inEvent) {
        // Three-way cycle: game → event → game (skip total)
        if (panelStatsMode === 'game') {
            panelStatsMode = 'event';
        } else {
            panelStatsMode = 'game';
        }
    } else {
        // Two-way: game ↔ total
        panelStatsMode = panelStatsMode === 'game' ? 'total' : 'game';
    }

    panelShowingTotalStats = panelStatsMode === 'total';

    const toggle = document.getElementById('panelStatsToggle');
    if (toggle) {
        const labels = { game: 'Game', event: 'Event', total: 'Total' };
        toggle.textContent = labels[panelStatsMode] || 'Game';
    }

    // Entering event mode: load the event-aggregated stats once (async cloud
    // load), cache them, then re-render so the table shows real numbers. The
    // first synchronous render below runs with cachedPanelEventStats still null
    // (cells fall back to live game values) and is corrected when the load
    // resolves. Leaving event mode clears the cache.
    //
    // Aggregate over the OTHER event games and exclude the current game: the
    // renderers add the live per-player game time/points on top, and the
    // current game's completed points are also synced to the cloud during play
    // — so including it here would double-count them. Excluding it makes every
    // point count exactly once (other games from the cloud, this game live),
    // independent of when the coach toggled into event mode.
    if (panelStatsMode === 'event' && currentEvent && typeof getEventPlayerStats === 'function') {
        cachedPanelEventStats = null;
        const otherGameIds = (currentEvent.gameIds || []).filter(id => id !== game.id);
        const otherGamesEvent = { ...currentEvent, gameIds: otherGameIds };
        getEventPlayerStats(otherGamesEvent)
            .then(stats => { cachedPanelEventStats = stats || {}; updateSelectLineTable(); })
            .catch(() => { cachedPanelEventStats = {}; });
    } else {
        cachedPanelEventStats = null;
    }
    updateSelectLineTable();
}

// =============================================================================
// Line Selection Actions (Wholesale = clear, Auto = fill empty slots)
// =============================================================================

/**
 * Map context → table element ID
 * @param {string} context - 'main' or 'sub'
 * @returns {string}
 */
function getContextTableId(context) {
    switch (context) {
        case 'main': return 'panelActivePlayersTable';
        case 'sub': return 'subPlayersTable';
        default: return 'panelActivePlayersTable';
    }
}

/**
 * Build per-player auto-line stats for the CURRENT game. Pure given (game,
 * roster) plus getPlayerGameTime — no DOM, no mutation — so it's easy to reason
 * about and exercise from the console.
 *
 * Each entry carries everything the Auto comparator needs:
 *   - pointsPlayed: points this player appeared in (incl. mid-point subs)
 *   - timePlayed:   ms on the field this game (getPlayerGameTime)
 *   - inLastPoint:  was on the most recent point's line
 *   - outStreak:    consecutive most-recent points sat out (never-played = all)
 *   - quintile:     0..4 bucket by timePlayed across the roster (0 = least time);
 *                   equal-time players share a bucket so ties aren't split
 * @param {object} game
 * @param {Array} roster
 * @returns {Object<string, {pointsPlayed:number,timePlayed:number,inLastPoint:boolean,outStreak:number,quintile:number}>}
 */
function buildAutoLineStats(game, roster) {
    const points = (game && game.points) || [];
    const lastPoint = points.length ? points[points.length - 1] : null;
    const lastPointPlayers = lastPoint ? lastPoint.players : [];

    const playedIn = (point, name) =>
        point.players.includes(name) ||
        (point.substitutedOutPlayers && point.substitutedOutPlayers.includes(name));

    const stats = {};
    roster.forEach(p => {
        let pointsPlayed = 0;
        points.forEach(pt => { if (playedIn(pt, p.name)) pointsPlayed++; });
        // Consecutive points sat out, walking back from the most recent point.
        let outStreak = 0;
        for (let i = points.length - 1; i >= 0; i--) {
            if (playedIn(points[i], p.name)) break;
            outStreak++;
        }
        stats[p.name] = {
            pointsPlayed,
            timePlayed: typeof getPlayerGameTime === 'function' ? getPlayerGameTime(p.name) : 0,
            inLastPoint: lastPointPlayers.includes(p.name),
            outStreak,
            quintile: 0,
        };
    });

    // Quintiles by game time ascending. Equal-count buckets via floor(i*5/n),
    // but players with identical time inherit the earlier bucket so a tie at a
    // boundary never lands two equal-time players in different equivalence
    // classes (the whole point of "about the same time").
    const byTime = [...roster].sort((a, b) => stats[a.name].timePlayed - stats[b.name].timePlayed);
    const n = byTime.length;
    let prevTime = null, prevQ = 0;
    byTime.forEach((p, i) => {
        let q = n > 0 ? Math.floor((i * 5) / n) : 0;
        if (prevTime !== null && stats[p.name].timePlayed === prevTime) q = prevQ;
        stats[p.name].quintile = q;
        prevTime = stats[p.name].timePlayed;
        prevQ = q;
    });

    return stats;
}

/**
 * Compute a complete line by filling the empty slots around an existing
 * selection. Already-selected players are kept; only the remaining slots (up to
 * the field count) are filled. Candidates are chosen in this strict order of
 * priority (decreasing):
 *   1. Gender ratio — satisfy the active ratio's per-gender targets first
 *   2. Rest — players NOT on the last point come before those who just played
 *   3. Less time played — by time quintile (least-played quintile first)
 *   4. (tiebreak within a quintile) fewer points played
 *   5. (tiebreak) longest current bench streak (out the most points in a row)
 * @param {string[]} alreadySelected - player names the coach has already picked
 * @returns {string[]} The full line (alreadySelected + auto-filled additions)
 */
function computeAutoLine(alreadySelected = []) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const roster = typeof getActiveRoster === 'function'
        ? getActiveRoster()
        : (currentTeam && currentTeam.teamRoster) || [];
    if (!game || !roster || !roster.length) return alreadySelected.slice();

    const expectedCount = parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
    const selectedSet = new Set(alreadySelected);
    const result = alreadySelected.slice();
    if (result.length >= expectedCount) return result;

    const stats = buildAutoLineStats(game, roster);

    // Strict lexicographic priority: rest > time quintile > fewer points >
    // longer bench streak > name (stable final tiebreak).
    const cmp = (a, b) => {
        const sa = stats[a.name], sb = stats[b.name];
        if (sa.inLastPoint !== sb.inLastPoint) return sa.inLastPoint ? 1 : -1;
        if (sa.quintile !== sb.quintile) return sa.quintile - sb.quintile;
        if (sa.pointsPlayed !== sb.pointsPlayed) return sa.pointsPlayed - sb.pointsPlayed;
        if (sa.outStreak !== sb.outStreak) return sb.outStreak - sa.outStreak;
        return a.name.localeCompare(b.name);
    };

    // Append up to `n` unselected candidates (already filtered + sorted) to result.
    const addFrom = (candidates, n) => {
        for (let i = 0; i < candidates.length && n > 0; i++) {
            if (!selectedSet.has(candidates[i].name)) {
                result.push(candidates[i].name);
                selectedSet.add(candidates[i].name);
                n--;
            }
        }
    };

    // Check if gender ratio is active
    const hasRatio = game.alternateGenderRatio && game.alternateGenderRatio !== 'No';

    if (hasRatio && typeof getExpectedGenderCounts === 'function') {
        let expectedRatio;
        if (game.alternateGenderRatio === 'Alternating' && typeof getExpectedGenderRatio === 'function') {
            expectedRatio = getExpectedGenderRatio(game);
        } else {
            // Fixed ratio like "4:3" — determine which gender is majority
            const parts = String(game.alternateGenderRatio).split(':');
            if (parts.length === 2) {
                expectedRatio = parseInt(parts[0]) >= parseInt(parts[1]) ? 'FMP' : 'MMP';
            }
        }

        if (expectedRatio) {
            const counts = getExpectedGenderCounts(expectedCount, expectedRatio);
            // How many of each gender are already on the line — fill only the deficit.
            let haveFmp = 0, haveMmp = 0;
            roster.forEach(p => {
                if (!selectedSet.has(p.name)) return;
                if (p.gender === Gender.FMP) haveFmp++;
                else if (p.gender === Gender.MMP) haveMmp++;
            });
            const fmpPlayers = roster.filter(p => p.gender === Gender.FMP).sort(cmp);
            const mmpPlayers = roster.filter(p => p.gender === Gender.MMP).sort(cmp);
            addFrom(fmpPlayers, Math.max(0, counts.fmp - haveFmp));
            addFrom(mmpPlayers, Math.max(0, counts.mmp - haveMmp));

            // Fallback: short a gender (or over on one) — top up from whoever's left.
            if (result.length < expectedCount) {
                addFrom([...roster].sort(cmp), expectedCount - result.length);
            }
            return result;
        }
    }

    // No ratio: fill remaining slots by the priority comparator
    addFrom([...roster].sort(cmp), expectedCount - result.length);
    return result;
}

/**
 * Set checkboxes in a given table to match a list of player names.
 * Does NOT dispatch change events — caller is responsible for saving state and updating UI.
 * @param {string} tableId
 * @param {string[]} playerNames
 */
function setTableCheckboxes(tableId, playerNames) {
    const checkboxes = document.querySelectorAll(`#${tableId} input[type="checkbox"]`);
    checkboxes.forEach(cb => {
        cb.checked = playerNames.includes(cb.dataset.playerName);
    });
}

/**
 * Get currently checked player names from a table
 * @param {string} tableId
 * @returns {string[]}
 */
function getCheckedPlayersFromTable(tableId) {
    const checkboxes = document.querySelectorAll(`#${tableId} input[type="checkbox"]`);
    const names = [];
    checkboxes.forEach(cb => {
        if (cb.checked && cb.dataset.playerName) names.push(cb.dataset.playerName);
    });
    return names;
}

/**
 * Apply a target set of players to a context's table + state. Shared by the
 * Wholesale (clear) and Auto (fill) actions. Writes pendingNextLine BEFORE
 * touching checkboxes so a concurrent sync won't overwrite with stale data.
 * @param {string} context - 'main' or 'sub'
 * @param {string[]} targetPlayers
 */
function applyLineSelection(context, targetPlayers) {
    const tableId = getContextTableId(context);

    if (context === 'main') {
        const game = typeof currentGame === 'function' ? currentGame() : null;
        if (game && game.pendingNextLine) {
            const activeType = game.pendingNextLine.activeType || 'od';
            game.pendingNextLine[activeType + 'Line'] = targetPlayers;
            game.pendingNextLine[activeType + 'LineModifiedAt'] = new Date().toISOString();
            localLineEditTimestamps[activeType + 'Line'] = Date.now();
        }
    }

    // Update checkboxes to match (no change events fired)
    setTableCheckboxes(tableId, targetPlayers);

    if (context === 'main') {
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        updateSelectLineSubtitle();
    } else if (context === 'sub') {
        updateSubPlayersCount();
    }

    updatePlayByPlayPanelState();
    updatePanelGenderRatioDisplay();
}

/**
 * Wholesale action: clear all selected players for a context (one-shot).
 * @param {string} context - 'main' or 'sub'
 */
function clearLineSelection(context) {
    if (context !== 'sub' && !canEditSelectLinePanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need a coach role to change the line', 'warning');
        }
        return;
    }
    applyLineSelection(context, []);
}

/**
 * Auto action: fill the empty slots up to the field count, keeping whoever is
 * already selected (one-shot). If the line is already full, nothing can be
 * filled — fire a warning toast instead.
 * @param {string} context - 'main' or 'sub'
 */
function autoFillLineSelection(context) {
    if (context !== 'sub' && !canEditSelectLinePanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need a coach role to change the line', 'warning');
        }
        return;
    }

    const current = getCheckedPlayersFromTable(getContextTableId(context));
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
    if (current.length >= expectedCount) {
        if (typeof showControllerToast === 'function') {
            showControllerToast(`Line already full (${current.length}/${expectedCount}) — no slots to fill`, 'warning');
        }
        return;
    }

    applyLineSelection(context, computeAutoLine(current));
}

// Observer that keeps the line toolbar fitting its width.
let _lineToolbarResizeObserver = null;

/**
 * Attach a ResizeObserver to the line toolbar so its action labels collapse
 * as the toolbar narrows. Safe to call repeatedly — it re-binds to the
 * current toolbar element and runs an initial pass.
 */
function setupLineToolbarResponsive() {
    const toolbar = document.querySelector('.panel-selectLine .select-line-toolbar');
    if (!toolbar) return;
    if (window.ResizeObserver) {
        if (_lineToolbarResizeObserver) _lineToolbarResizeObserver.disconnect();
        _lineToolbarResizeObserver = new ResizeObserver(() => adjustLineToolbarCollapse(toolbar));
        _lineToolbarResizeObserver.observe(toolbar);
    }
    adjustLineToolbarCollapse(toolbar);
}

/**
 * Drop line-toolbar action labels one at a time until the toolbar fits, so it
 * never overflows. Wholesale's label goes first (its blank-checkbox icon is
 * self-explanatory), then Auto's. Labels stay on by default at all widths.
 * @param {HTMLElement} [toolbar]
 */
function adjustLineToolbarCollapse(toolbar) {
    toolbar = toolbar || document.querySelector('.panel-selectLine .select-line-toolbar');
    if (!toolbar) return;
    // The toolbar is roomy now that Wholesale and the stats toggle moved into
    // the table header. If it still can't fit, drop the Auto label to its icon.
    // Reading scrollWidth between class changes forces the reflow to re-measure.
    toolbar.classList.remove('toolbar-collapse-1');
    if (toolbar.clientWidth === 0) return; // not visible yet
    if (toolbar.scrollWidth <= toolbar.clientWidth) return;
    toolbar.classList.add('toolbar-collapse-1');
}

/**
 * Handle O/D toggle button click
 * Cycles between 'od' → 'o' → 'd' → 'od'.
 */
function handleODToggle() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;

    // No editability check: per TODO design, the O|D toggle stays
    // interactive even when the panel is greyed (read-only). Viewing
    // different line types is independent of editing — the AC who
    // doesn't hold LC needs to follow along visually.
    //
    // activeType writes are local-only (filtered out of cloud sync per
    // store/storage.js), so a non-coach toggle has no cross-device
    // side-effects. The LC-viewing instrumentation in
    // noteLineCoachViewing is gated on isLineCoach() and only fires
    // for an actual LC, never for a viewer or greyed-out AC.

    // Save current selections before switching (don't update timestamp - just viewing)
    savePanelSelectionsToPendingNextLine(false);

    // Flip to the other type within the active planning mode:
    //   Combined → Next (odLine) ↔ On Deck (odOnDeckLine)
    //   Separate → O line ↔ D line
    const pair = lineTypeTogglePair(game);
    const currentType = game.pendingNextLine.activeType || pair[0];
    const idx = pair.indexOf(currentType);
    const nextType = pair[(idx + 1) % pair.length];

    game.pendingNextLine.activeType = nextType;
    // Honor this view for the rest of the planning window — the 3s cloud poll
    // calls autoSelectActiveTypeForNextPoint and would otherwise snap it back to
    // the who-scored default (e.g. you score → default D, but you're setting O).
    lineViewManuallyChosen = true;
    noteLineCoachViewing();

    // Save game state
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }

    // Refresh the table to show the new line's selections
    updateSelectLineTable();

    // Update button text
    updateODToggleButton();

    // Update subtitle for new line type
    updateSelectLineSubtitle();

    // Also update Play-by-Play panel (Start Point button depends on selections)
    updatePlayByPlayPanelState();

    // Show feedback
    const typeLabels = { od: 'Next', o: 'Offense', d: 'Defense', odOnDeck: 'On Deck' };
    if (typeof showControllerToast === 'function') {
        showControllerToast(`Switched to ${typeLabels[nextType]} line`, 'info');
    }
}

/**
 * The two line-type buckets the toggle flips between, given the current
 * planning mode. Combined → Next (odLine) and On Deck; Separate → O and D.
 * @param {object} game
 * @returns {string[]} two activeType values
 */
function lineTypeTogglePair(game) {
    const sep = !!(game && game.pendingNextLine && game.pendingNextLine.useSeparateLines);
    return sep ? ['o', 'd'] : ['od', 'odOnDeck'];
}

/**
 * Handle the Combined/Separate planning-mode selector. Persists + syncs the
 * flag and snaps activeType to a valid bucket for the chosen mode.
 */
/**
 * Set the line-planning mode. Combined (false) = one Next line + On Deck;
 * Separate (true) = distinct O and D lines.
 * @param {boolean} separate
 */
function setLineMode(separate) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    if (!canEditSelectLinePanel()) {
        updateODToggleButton();
        if (typeof showControllerToast === 'function') {
            showControllerToast('Only the Line Coach can change this during a point', 'warning');
        }
        return;
    }
    if (!!game.pendingNextLine.useSeparateLines === !!separate) return; // no change

    game.pendingNextLine.useSeparateLines = !!separate;
    game.pendingNextLine.useSeparateLinesAt = new Date().toISOString();

    // Snap the view to a bucket valid for the new mode. Separate → default to
    // the side that's actually coming up; Combined → the Next line.
    if (separate) {
        const offense = (typeof determineStartingPosition === 'function')
            ? determineStartingPosition() === 'offense' : true;
        game.pendingNextLine.activeType = offense ? 'o' : 'd';
    } else {
        game.pendingNextLine.activeType = 'od';
    }
    lineViewManuallyChosen = false; // mode change resets to the sensible default
    noteLineCoachViewing();

    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    updateSelectLineTable();
    updateODToggleButton();
    updateSelectLineSubtitle();
    updatePlayByPlayPanelState();
}

// ── Combined/Separate ("Mode:") popup menu ────────────────────────────────
function onLineModeOutsideClick(e) {
    const menu = document.getElementById('lineModeMenu');
    const btn = document.getElementById('panelLineModeBtn');
    if (menu && !menu.contains(e.target) && e.target !== btn) closeLineModeMenu();
}
function onLineModeKey(e) { if (e.key === 'Escape') closeLineModeMenu(); }

function closeLineModeMenu() {
    const menu = document.getElementById('lineModeMenu');
    if (menu) menu.remove();
    document.removeEventListener('click', onLineModeOutsideClick, true);
    document.removeEventListener('keydown', onLineModeKey);
}

/**
 * Open (or close) the "Mode:" popup. Two choices — O/D (combined) and O&D
 * (separate) — each with a one-line explanation.
 */
function toggleLineModeMenu() {
    if (document.getElementById('lineModeMenu')) { closeLineModeMenu(); return; }
    const btn = document.getElementById('panelLineModeBtn');
    if (!btn) return;
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const separate = !!(game && game.pendingNextLine && game.pendingNextLine.useSeparateLines);

    const menu = document.createElement('div');
    menu.className = 'line-mode-menu';
    menu.id = 'lineModeMenu';
    [
        { sep: false, title: 'O/D', desc: 'One combined roster' },
        { sep: true,  title: 'O&D', desc: 'Separate O & D lines' }
    ].forEach(o => {
        const opt = document.createElement('button');
        opt.className = 'line-mode-option' + (o.sep === separate ? ' selected' : '');
        const t = document.createElement('span');
        t.className = 'line-mode-option-title';
        t.textContent = o.title;
        const d = document.createElement('span');
        d.className = 'line-mode-option-desc';
        d.textContent = o.desc;
        opt.appendChild(t);
        opt.appendChild(d);
        opt.addEventListener('click', () => { setLineMode(o.sep); closeLineModeMenu(); });
        menu.appendChild(opt);
    });
    document.body.appendChild(menu);

    // Anchor below the button, kept within the viewport.
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${r.bottom + 4}px`;
    let left = r.left;
    if (left + menu.offsetWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
    }
    menu.style.left = `${left}px`;

    // Defer listener attachment so the opening click doesn't immediately close it.
    setTimeout(() => {
        document.addEventListener('click', onLineModeOutsideClick, true);
        document.addEventListener('keydown', onLineModeKey);
    }, 0);
}

/**
 * Sync the line-type toggle button and the Combined/Separate selector to the
 * current planning mode + active view.
 */
function updateODToggleButton() {
    const btn = document.getElementById('panelODToggle');
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const separate = !!(game?.pendingNextLine?.useSeparateLines);
    let activeType = game?.pendingNextLine?.activeType || 'od';

    // Guard: if the stored view doesn't belong to the current mode (e.g. after
    // a mode flip arriving via sync), fall back to the mode's primary bucket.
    const pair = separate ? ['o', 'd'] : ['od', 'odOnDeck'];
    if (!pair.includes(activeType)) activeType = pair[0];

    // Keep the Combined/Separate pill in sync (it also reflects a synced flip).
    const modeBtn = document.getElementById('panelLineModeBtn');
    if (modeBtn) {
        modeBtn.textContent = separate ? 'Mode: O&D' : 'Mode: O/D';
        modeBtn.title = separate
            ? 'Separate O & D lines (tap to change line-planning mode)'
            : 'One combined roster (tap to change line-planning mode)';
    }

    if (!btn) { adjustLineToolbarCollapse(); return; }

    const typeLabels = { od: 'Next', odOnDeck: 'On Deck', o: 'O', d: 'D' };
    btn.textContent = typeLabels[activeType] || 'Next';

    const typeDescriptions = {
        od: 'Next line (tap to plan the On Deck line)',
        odOnDeck: 'On Deck line — the point after Next (tap to switch back to Next)',
        o: 'Offense line (tap to switch to Defense)',
        d: 'Defense line (tap to switch to Offense)'
    };
    btn.title = typeDescriptions[activeType] || 'Toggle line type';

    // Color cue only in Separate mode: green O / red D. Combined stays neutral.
    btn.classList.toggle('active-o', activeType === 'o');
    btn.classList.toggle('active-d', activeType === 'd');

    // Label/text widths may have changed — re-evaluate the responsive collapse.
    adjustLineToolbarCollapse();
}

/**
 * Handle Start Point button click
 * Validates selection and starts the point with role-aware panel transitions
 */
function handlePanelStartPoint() {
    console.log('🏃 handlePanelStartPoint called');
    
    // Check if point is already in progress
    if (typeof isPointInProgress === 'function' && isPointInProgress()) {
        console.log('🏃 Point already in progress, ignoring');
        return;
    }
    
    // Check if we can start a point (need Active Coach role, not just lineup edit)
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('Only the Active Coach can start a new point', 'warning');
        }
        return;
    }
    
    // Get selected players
    const selectedPlayers = getSelectedPlayersFromPanel();
    console.log('🏃 Selected players:', selectedPlayers);
    
    // Get expected player count
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
    
    // Validate player count
    if (selectedPlayers.length === 0) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('Please select players for the point', 'warning');
        }
        return;
    }
    
    // Warn but allow if count is wrong
    if (selectedPlayers.length !== expectedCount) {
        console.warn(`Starting point with ${selectedPlayers.length} players (expected ${expectedCount})`);
    }
    
    // Note: Don't stop game state refresh - viewers need updates during points
    // The refresh logic handles Active Coach differently (no full refresh during point)
    
    // Use existing startNextPoint logic from pointManagement.js
    if (typeof startNextPoint === 'function') {
        console.log('🏃 Calling startNextPoint()');
        startNextPoint();
        
        // Role-aware panel transitions (only if we didn't navigate away)
        // startNextPoint may have called enterGameScreen which handles this
        if (isGameScreenVisible()) {
            const state = typeof getControllerState === 'function' ? getControllerState() : {};
            const hasActiveCoach = state.isActiveCoach;
            
            // Update displays
            updateSelectLinePanelState();
            
            // Update Play-by-Play panel state (buttons now enabled since point started)
            updatePlayByPlayPanelState();
        }
    } else {
        console.warn('🏃 startNextPoint function not available');
    }
}

/**
 * Handle Lines button click
 * Opens the line selection dialog
 */
function handlePanelLinesClick() {
    showLineSelectionDialog();
}

/**
 * Show the line selection dialog (panel-UI version).
 * Reads lines from currentTeam.lines, lets the user pick one,
 * then checks/unchecks panelActivePlayersTable checkboxes accordingly.
 */
let shouldClearSelectionsInLineDialog = true;

function showLineSelectionDialog() {
    if (!currentTeam || !currentTeam.lines || currentTeam.lines.length === 0) {
        alert('No lines have been created yet. Please create lines in the roster management screen.');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'select-line-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'select-line-dialog';

    const heading = document.createElement('h3');
    heading.textContent = 'Select Line';
    dialog.appendChild(heading);

    // Checkbox for clearing existing selections
    const checkboxContainer = document.createElement('div');
    checkboxContainer.className = 'clear-selections-checkbox-container';

    const clearCheckbox = document.createElement('input');
    clearCheckbox.type = 'checkbox';
    clearCheckbox.id = 'clearSelectionsCheckbox';
    clearCheckbox.checked = shouldClearSelectionsInLineDialog;

    const clearLabel = document.createElement('label');
    clearLabel.htmlFor = 'clearSelectionsCheckbox';
    clearLabel.textContent = 'Clear existing selections';

    checkboxContainer.appendChild(clearCheckbox);
    checkboxContainer.appendChild(clearLabel);
    dialog.appendChild(checkboxContainer);

    const radioContainer = document.createElement('div');
    radioContainer.className = 'select-line-radio-container';

    let selectedLine = null;

    currentTeam.lines.forEach((line, index) => {
        const option = document.createElement('div');
        option.className = 'select-line-radio-option';
        if (currentGame && currentGame().lastLineUsed === line.name) {
            option.classList.add('last-used');
        }

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'lineSelection';
        radio.id = `line-${index}`;
        radio.value = line.name;

        const label = document.createElement('label');
        label.htmlFor = `line-${index}`;

        const lineName = document.createElement('span');
        lineName.className = 'line-name';
        lineName.textContent = line.name;

        const players = document.createElement('span');
        players.className = 'line-players';
        players.textContent = line.players.join(', ');

        label.appendChild(lineName);
        label.appendChild(players);

        radio.addEventListener('change', () => {
            selectedLine = line;
            selectButton.disabled = false;
        });

        option.appendChild(radio);
        option.appendChild(label);
        radioContainer.appendChild(option);
    });

    dialog.appendChild(radioContainer);

    const buttons = document.createElement('div');
    buttons.className = 'select-line-buttons';

    const selectButton = document.createElement('button');
    selectButton.className = 'select-line-button select';
    selectButton.textContent = 'Select';
    selectButton.disabled = true;
    selectButton.addEventListener('click', () => {
        if (selectedLine) {
            // Update panel table checkboxes
            const panelCheckboxes = document.querySelectorAll('#panelActivePlayersTable input[type="checkbox"]');

            if (clearCheckbox.checked) {
                panelCheckboxes.forEach(checkbox => { checkbox.checked = false; });
            }

            panelCheckboxes.forEach(checkbox => {
                if (checkbox.dataset.playerName && selectedLine.players.includes(checkbox.dataset.playerName)) {
                    checkbox.checked = true;
                }
            });

            // Clear stored next line selections since we just made a new selection
            if (typeof clearNextLineSelections === 'function') {
                clearNextLineSelections();
            }

            // Update the last used line and save
            currentGame().lastLineUsed = selectedLine.name;
            if (typeof saveAllTeamsData === 'function') {
                saveAllTeamsData();
            }

            // Update panel state
            savePanelSelectionsToPendingNextLine();
            updateSelectLineSubtitle();
            updatePlayByPlayPanelState();

            shouldClearSelectionsInLineDialog = false;

            overlay.remove();
        }
    });

    const cancelButton = document.createElement('button');
    cancelButton.className = 'select-line-button cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => {
        overlay.remove();
    });

    buttons.appendChild(selectButton);
    buttons.appendChild(cancelButton);
    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

/**
 * Check for conflicts when editing the line
 * Warns if another coach edited the same line type within the last 5 seconds
 */
function checkForLineEditConflict() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    
    // Only check between points
    if (typeof isPointInProgress === 'function' && isPointInProgress()) return;
    
    // Check if we already showed a toast for this point
    const currentPointIndex = game.points.length;
    if (lastConflictToastPointIndex === currentPointIndex) return;
    
    const activeType = game.pendingNextLine.activeType || 'od';
    const lineKey = activeType + 'Line';
    
    // Get the modification timestamp for the current line type
    const modTimestampKey = activeType + 'LineModifiedAt';
    const remoteModTimestamp = game.pendingNextLine[modTimestampKey];
    
    if (!remoteModTimestamp) return;
    
    const remoteTime = new Date(remoteModTimestamp).getTime();
    const now = Date.now();
    const fiveSecondsAgo = now - 5000;
    const localEditTime = localLineEditTimestamps[lineKey] || 0;
    
    // If remote timestamp is newer than our last edit AND within 5 seconds,
    // someone else edited after us
    if (remoteTime > localEditTime && remoteTime > fiveSecondsAgo) {
        // Get the other coach's name from controller state
        const state = typeof getControllerState === 'function' ? getControllerState() : {};
        let otherCoachName = null;
        
        if (state.isActiveCoach && state.lineCoach) {
            otherCoachName = state.lineCoach.displayName;
        } else if (state.isLineCoach && state.activeCoach) {
            otherCoachName = state.activeCoach.displayName;
        }
        
        if (otherCoachName) {
            if (typeof showControllerToast === 'function') {
                showControllerToast(`Warning: ${otherCoachName} is also editing this line`, 'warning');
            }
            lastConflictToastPointIndex = currentPointIndex;
        }
    }
}

/**
 * Show a toast when another coach updates the game state.
 * Throttled to at most once every 10 seconds to avoid spamming.
 */
function showGameUpdatedToast(changes) {
    const now = Date.now();
    if (now - lastGameUpdatedToastTime < 10000) return;
    lastGameUpdatedToastTime = now;

    // Get the other coach's name from controller state
    const state = typeof getControllerState === 'function' ? getControllerState() : {};
    const coachName = state.activeCoach?.displayName;
    const who = coachName || 'Another coach';

    if (typeof showControllerToast === 'function') {
        showControllerToast(`${who} updated the game`, 'info', 4000);
    }
}

/**
 * Handle checkbox change in the player selection table
 * @param {Event} e - Change event
 */
function handlePanelCheckboxChange(e) {
    if (!e.target || !e.target.matches('input[type="checkbox"]')) return;

    // Check permission
    if (!canEditSelectLinePanel()) {
        // Revert the change
        e.target.checked = !e.target.checked;
        if (typeof showControllerToast === 'function') {
            showControllerToast('Only the Line Coach can edit during a point', 'warning');
        }
        return;
    }

    // Check for conflicts with other coach before saving
    checkForLineEditConflict();

    // Save to pending next line
    savePanelSelectionsToPendingNextLine();

    // Keep subtitle in sync
    updateSelectLineSubtitle();
    
    // Also update Play-by-Play panel (Start Point button state depends on selections)
    updatePlayByPlayPanelState();
}

/**
 * Handle starting gender ratio selection change
 */
function handlePanelStartingRatioChange(e) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game) return;
    
    game.startingGenderRatio = e.target.value;
    
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
    
    // Refresh display
    updateSelectLinePanel();
}

/**
 * Check if the current user can edit the Select Line panel checkboxes.
 *
 * Multi-coach rule (TODO.md § "Multi-Coach Line Selection: Intent Rule &
 * LC-Viewing Label"): editable iff the current user holds the Line Coach
 * role. The TODO's implementation pointer ("isActiveCoach && isLineCoach")
 * was an internal inconsistency with the rest of the design — which
 * explicitly describes the LC editing lines and the AC observing via the
 * "Line Coach: viewing/editing the X line" label. The right invariant is
 * "editing is tied to the LC role" so every configuration falls out
 * cleanly:
 *
 *   - Two users, AC ≠ LC → LC user edits; AC user observes (greyed).
 *   - Dual-role (same user holds both) → editable (holds LC).
 *   - LC role vacant while AC is claimed → AC sees the panel greyed
 *     until they explicitly claim LC (single tap). Keeps editing always
 *     tied to LC and handles "LC went AFK": AC claims LC, edits,
 *     optionally releases.
 *
 * Solo coaching (no multi-coach detection): unchanged, no role
 * enforcement. Matches the panelSystem latch that hides the role-claim
 * buttons until two coaches are seen at least once in the session.
 *
 * Note: the O|D toggle (`handleODToggle`) is intentionally NOT gated on
 * this — viewing different line types is independent of editability,
 * so a greyed-out AC can still browse O / D / OD views to follow
 * along with what the LC is preparing.
 *
 * @returns {boolean}
 */
function canEditSelectLinePanel() {
    const state = typeof getControllerState === 'function' ? getControllerState() : {};
    const multiCoach = typeof window.isMultiCoachDetected === 'function'
        ? window.isMultiCoachDetected()
        : false;

    // Solo coaching (or pre-multi-coach detection): no role enforcement.
    if (!multiCoach) {
        return true;
    }

    // Multi-coach: editable iff the current user holds the Line Coach role.
    return state.isLineCoach;
}

/**
 * Get selected player names from the panel table
 * @returns {string[]} Array of player names
 */
function getSelectedPlayersFromPanel() {
    const checkboxes = document.querySelectorAll('#panelActivePlayersTable input[type="checkbox"]');
    const selectedPlayers = [];

    checkboxes.forEach(checkbox => {
        if (checkbox.checked && checkbox.dataset.playerName) {
            selectedPlayers.push(checkbox.dataset.playerName);
        }
    });

    return selectedPlayers;
}

/**
 * Save panel selections to the game's pendingNextLine
 */
/**
 * Save panel selections to pending next line
 * @param {boolean} updateTimestamp - Whether to update the modification timestamp (default: true)
 *   Set to false when just switching views (toggle), true when actually changing selections
 */
function savePanelSelectionsToPendingNextLine(updateTimestamp = true) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    
    const selectedPlayers = getSelectedPlayersFromPanel();
    const activeType = game.pendingNextLine.activeType || 'od';
    
    // Update the appropriate line array
    game.pendingNextLine[activeType + 'Line'] = selectedPlayers;
    
    // Only update the modification timestamp if actual selections changed
    // (not just viewing via toggle)
    if (updateTimestamp) {
        game.pendingNextLine[activeType + 'LineModifiedAt'] = new Date().toISOString();
        // Track our local edit time for conflict detection
        localLineEditTimestamps[activeType + 'Line'] = Date.now();
    }

    // Save (triggers sync)
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

/**
 * Check gender ratio for panel-selected players
 * Returns true if ratio is correct, false if wrong
 * @param {string[]} selectedPlayerNames - Array of selected player names
 * @param {number} expectedCount - Expected player count
 */
function checkPanelGenderRatio(selectedPlayerNames, expectedCount) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.alternateGenderRatio || game.alternateGenderRatio === 'No') {
        return true; // Not checking gender ratio
    }
    
    if (selectedPlayerNames.length !== expectedCount) {
        return true; // Wrong count, handled elsewhere
    }
    
    // Get player objects and count genders
    let fmpCount = 0;
    let mmpCount = 0;
    selectedPlayerNames.forEach(name => {
        const player = currentTeam?.teamRoster?.find(p => p.name === name);
        if (player) {
            if (player.gender === Gender.FMP) fmpCount++;
            else if (player.gender === Gender.MMP) mmpCount++;
        }
    });
    
    // Handle fixed ratio (e.g., "4:3", "3:2")
    if (game.alternateGenderRatio !== 'Alternating') {
        const ratioParts = game.alternateGenderRatio.split(':');
        if (ratioParts.length === 2) {
            const expectedFmp = parseInt(ratioParts[0], 10);
            const expectedMmp = parseInt(ratioParts[1], 10);
            return fmpCount === expectedFmp && mmpCount === expectedMmp;
        }
    }
    
    // Handle alternating ratio
    const expectedRatio = typeof getExpectedGenderRatio === 'function' 
        ? getExpectedGenderRatio(game) 
        : null;
    if (!expectedRatio) return true; // No ratio set yet
    
    // Determine expected counts based on player count and ratio
    const expectedCounts = typeof getExpectedGenderCounts === 'function'
        ? getExpectedGenderCounts(expectedCount, expectedRatio)
        : null;
    if (!expectedCounts) return true;
    
    return fmpCount === expectedCounts.fmp && mmpCount === expectedCounts.mmp;
}

/**
 * Update the Select Line panel based on game state and permissions
 */
function updateSelectLinePanelState() {
    const canEdit = canEditSelectLinePanel();
    const panel = document.getElementById('panel-selectLine');
    const readonlyOverlay = document.getElementById('panelReadonlyOverlay');
    
    // Update readonly overlay
    if (readonlyOverlay) {
        readonlyOverlay.style.display = canEdit ? 'none' : 'flex';
    }
    
    // Update panel visual state
    if (panel) {
        panel.classList.toggle('readonly', !canEdit);
    }
    
    // Disable/enable checkboxes
    const checkboxes = document.querySelectorAll('#panelActivePlayersTable input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.disabled = !canEdit;
    });
    
    // Update gender ratio display
    updatePanelGenderRatioDisplay();

    // Update subtitle (shown when minimized)
    updateSelectLineSubtitle();
}

/**
 * Update gender ratio display in the panel
 */
function updatePanelGenderRatioDisplay() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const badge = document.getElementById('panelGenderBadge');
    const ratioSelection = document.getElementById('panelStartingRatioSelection');

    if (!game || !game.alternateGenderRatio || game.alternateGenderRatio === 'No') {
        if (badge) badge.style.display = 'none';
        if (ratioSelection) ratioSelection.style.display = 'none';
        adjustLineToolbarCollapse();
        return;
    }

    // Fixed ratio (e.g., "4:3")
    if (game.alternateGenderRatio !== 'Alternating') {
        if (badge) {
            badge.textContent = game.alternateGenderRatio;
            badge.className = 'select-line-gender-badge gender-badge-neutral';
            badge.style.display = '';
            badge.onclick = null;
        }
        if (ratioSelection) ratioSelection.style.display = 'none';
        adjustLineToolbarCollapse();
        return;
    }

    // Alternating ratio
    const expectedRatio = typeof getExpectedGenderRatio === 'function'
        ? getExpectedGenderRatio(game)
        : null;

    if (expectedRatio) {
        if (badge) {
            badge.textContent = `+${expectedRatio} point`;
            badge.className = 'select-line-gender-badge ' +
                (expectedRatio === 'FMP' ? 'gender-badge-fmp' : 'gender-badge-mmp');
            badge.style.display = '';
            badge.onclick = null;
        }
        if (ratioSelection) ratioSelection.style.display = 'none';
    } else {
        // Need to select starting ratio — show selection row, hide badge
        if (badge) badge.style.display = 'none';
        const fmpRadio = document.getElementById('panelStartingRatioFMP');
        const mmpRadio = document.getElementById('panelStartingRatioMMP');
        if (fmpRadio) fmpRadio.checked = false;
        if (mmpRadio) mmpRadio.checked = false;
        if (ratioSelection) ratioSelection.style.display = 'block';
    }
    adjustLineToolbarCollapse();
}

/**
 * Select the appropriate line type at the end of a point
 * Logic:
 * - If O/D line was modified after the point started, use O/D line
 * - Otherwise, use O line (if team will be on offense) or D line (if team will be on defense)
 */
/**
 * Determine which line will be used for the next point.
 *
 * CRITICAL INVARIANT: the returned `source` is always side-consistent
 * with `determineStartingPosition()` — either `typeKey` (the determined
 * side) or `'od'` (the combined line). It is NEVER the opposite side.
 * The side is fixed by who scored; this function only chooses WHICH line
 * to use on that side. (Downstream, applyStartPointButtonState reads
 * source 'o'→offense / 'd'→defense, so a side-flipped source would
 * mislabel the button and field the wrong unit.)
 *
 * Priority order:
 *
 *   1. LC view preference. If `lineCoachViewing` is set and its
 *      timestamp is newer than every relevant *ModifiedAt, honor the
 *      LC's current view — but only as combined-OD vs side-specific:
 *      'od' → odLine; anything else → the determined side's line. The
 *      LC's view never flips the side.
 *
 *   2. Per-axis most-recent edit. For an upcoming O point compare oLine
 *      vs odLine timestamps; for a D point, dLine vs odLine. Newer
 *      non-empty side wins.
 *
 *   3. Same-side fallback. If the winner was empty, fall through to the
 *      other same-side option (this-side typed ↔ odLine) — never the
 *      opposite side.
 *
 *   4. lastPoint safety net. If all same-side options are still empty
 *      (cross-device sync lag, edge case), surface the just-played
 *      lineup so the AC's Start Point button stays actionable.
 *
 * Returns `{ source, line }` where `source` is `'o' | 'd' | 'od'`.
 */
function getEffectiveLineForNextPoint(game) {
    if (!game || !game.pendingNextLine) return { source: 'od', line: [] };

    const isOffense = (typeof determineStartingPosition === 'function')
        ? determineStartingPosition() === 'offense'
        : true;
    const typeKey  = isOffense ? 'o' : 'd';

    const p = game.pendingNextLine;
    const typedLine = p[typeKey  + 'Line'] || [];
    const odLine    = p.odLine             || [];
    const typedTime = p[typeKey + 'LineModifiedAt']
        ? new Date(p[typeKey + 'LineModifiedAt']).getTime() : 0;
    const odTime    = p.odLineModifiedAt
        ? new Date(p.odLineModifiedAt).getTime() : 0;

    // ── Priority 1: LC view preference ────────────────────────────────
    // The LC's current view (synced via lineCoachViewing) is a soft
    // tiebreaker. If it's newer than every relevant *ModifiedAt, treat
    // it as "this is what they're planning around" — 'od' means combined
    // OD line, anything else means use the determined side's line. The
    // side itself is fixed by who scored; the view never flips it.
    // 'odOnDeck' is NOT a Next-line view — it's the point-after-next. Treat it
    // as "no Next-line view preference" here, else Priority 1 would resolve an
    // On Deck view into a Next bucket (it falls through to typeKey).
    const lcView   = (p.lineCoachViewing === 'odOnDeck') ? null : p.lineCoachViewing;
    const lcViewAt = p.lineCoachViewingAt
        ? new Date(p.lineCoachViewingAt).getTime() : 0;
    if (lcView && lcViewAt > typedTime && lcViewAt > odTime) {
        const viewSource = (lcView === 'od') ? 'od' : typeKey;
        const viewLine = p[viewSource + 'Line'] || [];
        if (viewLine.length > 0) {
            return { source: viewSource, line: viewLine };
        }
        // View points at an empty line — fall through.
    }

    // ── Priority 2: per-axis most-recent edit ─────────────────────────
    // For an upcoming O point compare oLine vs odLine timestamps; for D
    // compare dLine vs odLine. Newer non-empty side wins. Per-axis (not
    // global) so that prepping a D line for the next defense point
    // doesn't surface an empty O line if the team scores instead.
    const typedNewer = typedTime > odTime;
    if (typedNewer && typedLine.length > 0) {
        return { source: typeKey, line: typedLine };
    }
    if (!typedNewer && odLine.length > 0) {
        return { source: 'od', line: odLine };
    }

    // ── Priority 3: empty-axis fallback ───────────────────────────────
    // The most-recent-edit winner was empty. Surface the OTHER same-side
    // option (this-side typed ↔ odLine) rather than a blank lineup — but
    // NEVER the opposite side's line. Falling back to the opposite side
    // would flip O↔D, contradicting who scored (this was the bug behind
    // "Start Point (O-line)" showing up right after we scored).
    if (typedLine.length > 0) {
        return { source: typeKey, line: typedLine };
    }
    if (odLine.length > 0) {
        return { source: 'od', line: odLine };
    }

    // ── Priority 4: last-point safety net ─────────────────────────────
    // Both same-side options are empty. transitionToBetweenPoints normally
    // pre-fills these from the just-played lineup, but defend against
    // cross-device sync lag (the AC may see this function run before the
    // LC's edits or the reset has reached this client). Surfacing the
    // most recent lineup keeps the Start Point button actionable — better
    // than a permanently greyed button stuck with no players. Tagged as
    // the determined side so the label matches reality.
    const lastPoint = game.points && game.points[game.points.length - 1];
    const lastPlayers = (lastPoint && lastPoint.players) || [];
    if (lastPlayers.length > 0) {
        return { source: typeKey, line: [...lastPlayers] };
    }
    return { source: typeKey, line: [] };
}

/**
 * Set `pendingNextLine.activeType` to match whichever line will be used
 * for the next point. Skipped in split mode (the user is intentionally
 * looking at both at once). Also skipped if no change is needed.
 *
 * Called both at point end (from selectAppropriateLineAtPointEnd) and
 * after cloud refresh (so the Active Coach's view follows the Line
 * Coach's edits without a manual toggle).
 */
// Set true when the coach manually picks a line view (O/D toggle) during a
// planning window, so the 3s cloud-refresh poll doesn't snap it back to the
// who-scored default. Cleared at point end (selectAppropriateLineAtPointEnd).
let lineViewManuallyChosen = false;

function autoSelectActiveTypeForNextPoint() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;

    // Don't yank a coach off the On Deck view when a point ends. If they're
    // planning the point-after-next, Next is presumably already set — leave
    // them where they are rather than auto-switching to the resolved Next side.
    if (game.pendingNextLine.activeType === 'odOnDeck') return;

    // Respect a manual O/D pick made during this planning window (see flag note).
    if (lineViewManuallyChosen) return;

    // In Combined mode there's only the Next (od) view — never auto-switch to a
    // side-specific o/d bucket the UI can't show. Selection itself still blends
    // o/d/od via getEffectiveLineForNextPoint at point start.
    if (!game.pendingNextLine.useSeparateLines) {
        if (game.pendingNextLine.activeType !== 'od') {
            game.pendingNextLine.activeType = 'od';
            if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        }
        return;
    }

    const { source } = getEffectiveLineForNextPoint(game);
    if (game.pendingNextLine.activeType !== source) {
        game.pendingNextLine.activeType = source;
        // activeType is local UI state — saveAllTeamsData persists to
        // localStorage but it's filtered out of the cloud sync (see
        // serializeGame). No multi-device cross-talk on this field.
        if (typeof saveAllTeamsData === 'function') {
            saveAllTeamsData();
        }
    }
}

function selectAppropriateLineAtPointEnd() {
    // New planning window → drop any manual O/D view pick so the who-scored
    // default applies; the coach can re-toggle and it'll stick (see flag note).
    lineViewManuallyChosen = false;
    // Delegate to the shared helper. The historical version of this
    // function had a 3-priority rule (stay on OD, then OD-modified-during-
    // point, then who-scored) — but that meant a separately-prepared O or
    // D line never got applied unless the user was already viewing it,
    // which contradicted the design intent that o/d lines persist across
    // points. The new rule (most recent edit between typed-vs-OD wins) is
    // simpler and matches what coaches actually expect. See
    // getEffectiveLineForNextPoint for the rule.
    autoSelectActiveTypeForNextPoint();
}

/**
 * Update the Select Line panel table with current roster and selections
 */
// Remembers the Select Line table's horizontal scroll position across the
// periodic rebuilds so a manual leftward scroll isn't clobbered by the
// snap-to-right in makePanelColumnsSticky(). null = treat as "follow latest".
let _selectLineScrollState = null;

function updateSelectLineTable() {
    const table = document.getElementById('panelActivePlayersTable');
    if (!table) return;
    
    const tableBody = table.querySelector('tbody');
    const tableHead = table.querySelector('thead');
    if (!tableBody || !tableHead) return;

    // Capture the horizontal scroll position before we blow away the table.
    // Clearing innerHTML resets scrollLeft to 0, and makePanelColumnsSticky()
    // re-snaps to the right edge to surface the latest points. That's the right
    // behavior on first render and while the user is "following" the newest
    // point, but it must NOT yank the view back if the user has scrolled left to
    // review earlier points (the 3s cloud-refresh rebuild would otherwise pop
    // them back to the right every cycle).
    const scrollContainer = document.getElementById('panelTableContainer');
    if (scrollContainer) {
        const maxScroll = scrollContainer.scrollWidth - scrollContainer.clientWidth;
        // Within 4px of the right edge (or nothing to scroll) counts as "following".
        const atRightEdge = maxScroll <= 4 || (maxScroll - scrollContainer.scrollLeft) <= 4;
        _selectLineScrollState = { scrollLeft: scrollContainer.scrollLeft, atRightEdge };
    }

    // Clear existing content
    tableBody.innerHTML = '';
    tableHead.innerHTML = '';
    
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !currentTeam) return;

    // Use event roster if in event, else team roster
    const activeRoster = typeof getActiveRoster === 'function' ? getActiveRoster() : currentTeam.teamRoster;
    if (!activeRoster || activeRoster.length === 0) return;

    // Get current pending selections
    const pendingLine = game.pendingNextLine || {};
    const activeType = pendingLine.activeType || 'od';
    const selectedPlayers = pendingLine[activeType + 'Line'] || [];

    // On Deck view adds a read-only "tentative next" projection column so the
    // LC planning the point-after-next can see who's already slated for the
    // *immediate* next point (and balance rest). Pure-derived, recomputed each
    // render. Source of the tentative-next set depends on phase: while a point
    // is in progress the O/D side is genuinely unknown, so use the combined
    // odLine; between points the side is resolved, so use the effective Next.
    const isOnDeckView = activeType === 'odOnDeck';
    let tentativeNextSet = [];
    if (isOnDeckView) {
        const inProgress = typeof isPointInProgress === 'function' && isPointInProgress();
        tentativeNextSet = inProgress
            ? (pendingLine.odLine || [])
            : (typeof getEffectiveLineForNextPoint === 'function'
                ? (getEffectiveLineForNextPoint(game).line || [])
                : []);
    }

    // Create header rows (score display)
    const runningScores = typeof getRunningScores === 'function'
        ? getRunningScores()
        : { team: [0], opponent: [0] };
    
    const teamScoreRow = document.createElement('tr');
    const opponentScoreRow = document.createElement('tr');
    
    // Check if last point is in progress (no winner yet)
    const pointInProgress = game.points.length > 0 && !game.points[game.points.length - 1].winner;

    // Add score cells helper
    const addScoreCells = (row, teamName, scores) => {
        const nameCell = document.createElement('th');
        nameCell.textContent = teamName;
        nameCell.setAttribute('colspan', '3');
        nameCell.classList.add('active-header-teams');
        row.appendChild(nameCell);

        scores.forEach((score, index) => {
            const scoreCell = document.createElement('th');
            // Show hyphen for the in-progress point's score column (last one)
            if (pointInProgress && index === scores.length - 1) {
                scoreCell.textContent = '-';
            } else {
                scoreCell.textContent = score;
            }

            // Color score cells based on gender ratio
            if (game.alternateGenderRatio === 'Alternating' && game.startingGenderRatio) {
                const genderRatio = typeof getGenderRatioForPoint === 'function'
                    ? getGenderRatioForPoint(game, index)
                    : null;
                if (genderRatio === 'FMP') scoreCell.classList.add('score-cell-fmp');
                else if (genderRatio === 'MMP') scoreCell.classList.add('score-cell-mmp');
            }

            row.appendChild(scoreCell);
        });
    };
    
    addScoreCells(teamScoreRow, game.team, runningScores.team);
    addScoreCells(opponentScoreRow, game.opponent, runningScores.opponent);

    // On Deck: trailing header for the tentative-next projection column.
    // rowspan 2 so only the team row carries it; the opponent row keeps its
    // column count without an extra cell.
    if (isOnDeckView) {
        const projHeader = document.createElement('th');
        // Line break stacks "On / Deck" vertically (CSS white-space: pre-line)
        // to keep the column narrow.
        projHeader.textContent = 'On\nDeck';
        projHeader.setAttribute('rowspan', '2');
        projHeader.title = 'On Deck point — projected points played by each player going in';
        projHeader.classList.add('active-ondeck-projection');
        // Color the header by the On Deck point's gender ratio, matching the
        // score-cell coloring used on the other headers. The ratio is
        // deterministic (fixed A-B-B-A alternation, independent of who wins),
        // so the point two ahead is known: its 0-based index is points.length+1
        // (the next point is points.length per getExpectedGenderRatio).
        if (game.alternateGenderRatio === 'Alternating' && game.startingGenderRatio) {
            const onDeckRatio = typeof getGenderRatioForPoint === 'function'
                ? getGenderRatioForPoint(game, game.points.length + 1)
                : null;
            if (onDeckRatio === 'FMP') projHeader.classList.add('score-cell-fmp');
            else if (onDeckRatio === 'MMP') projHeader.classList.add('score-cell-mmp');
        }
        teamScoreRow.appendChild(projHeader);
    }

    tableHead.appendChild(teamScoreRow);
    tableHead.appendChild(opponentScoreRow);

    // Controls header row: sits under the score rows, above the players. Holds
    // the Wholesale (clear) icon over the checkbox column, a "Player" label, and
    // the Game/Event stats toggle over the time column. The remaining
    // point-columns are blank. Clicks are handled via delegation on the table
    // container (wireSelectLineEvents). Light-grey banded via CSS.
    const controlsRow = document.createElement('tr');
    controlsRow.className = 'select-line-controls-row';

    const wholesaleTh = document.createElement('th');
    wholesaleTh.className = 'active-checkbox-column select-line-th-wholesale';
    wholesaleTh.title = 'Clear all selected players';
    wholesaleTh.innerHTML = WHOLESALE_ICON_SVG;
    controlsRow.appendChild(wholesaleTh);

    const playerTh = document.createElement('th');
    playerTh.className = 'active-name-column';
    playerTh.textContent = 'Player';
    controlsRow.appendChild(playerTh);

    const statsTh = document.createElement('th');
    statsTh.className = 'active-time-column select-line-th-stats';
    statsTh.title = 'Toggle the time column between this game and the whole event';
    const statsLabels = { game: 'Game', event: 'Event', total: 'Total' };
    statsTh.innerHTML = '<span class="select-line-stats-toggle" id="panelStatsToggle">'
        + (statsLabels[panelStatsMode] || 'Game') + '</span>';
    controlsRow.appendChild(statsTh);

    // Blank cells matching the per-point score columns, plus the On Deck
    // projection column (its score-row header is rowspan=2, so this third row
    // needs its own cell).
    const numPointCols = runningScores.team.length;
    for (let i = 0; i < numPointCols; i++) controlsRow.appendChild(document.createElement('th'));
    if (isOnDeckView) controlsRow.appendChild(document.createElement('th'));

    tableHead.appendChild(controlsRow);

    // Get last point players for sorting
    const lastPointPlayers = game.points.length > 0
        ? game.points[game.points.length - 1].players
        : [];
    
    // Sort roster (played last point, played any points, not played)
    const sortedRoster = [...activeRoster].sort((a, b) => {
        const aLastPoint = lastPointPlayers.includes(a.name);
        const bLastPoint = lastPointPlayers.includes(b.name);
        // Include players who were substituted out mid-point
        const aPlayedAny = game.points.some(p => 
            p.players.includes(a.name) || 
            (p.substitutedOutPlayers && p.substitutedOutPlayers.includes(a.name))
        );
        const bPlayedAny = game.points.some(p => 
            p.players.includes(b.name) || 
            (p.substitutedOutPlayers && p.substitutedOutPlayers.includes(b.name))
        );
        
        if (aLastPoint && !bLastPoint) return -1;
        if (!aLastPoint && bLastPoint) return 1;
        if (aPlayedAny && !bPlayedAny) return -1;
        if (!aPlayedAny && bPlayedAny) return 1;
        return a.name.localeCompare(b.name);
    });
    
    // Create player rows
    sortedRoster.forEach((player, idx) => {
        const row = document.createElement('tr');
        
        // Checkbox column
        const checkboxCell = document.createElement('td');
        checkboxCell.classList.add('active-checkbox-column');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('active-checkbox');
        checkbox.checked = selectedPlayers.includes(player.name);
        checkbox.dataset.playerName = player.name;
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);
        
        // Name column
        const nameCell = document.createElement('td');
        nameCell.classList.add('active-name-column');
        nameCell.textContent = typeof formatPlayerName === 'function' 
            ? formatPlayerName(player) 
            : player.name;
        
        // Gender color coding
        if (player.gender === Gender.FMP) nameCell.classList.add('player-fmp');
        else if (player.gender === Gender.MMP) nameCell.classList.add('player-mmp');
        
        // Click name to toggle checkbox
        nameCell.style.cursor = 'pointer';
        nameCell.addEventListener('click', () => checkbox.click());
        row.appendChild(nameCell);
        
        // Time column
        const timeCell = document.createElement('td');
        timeCell.classList.add('active-time-column');
        const gameTime = typeof getPlayerGameTime === 'function'
            ? getPlayerGameTime(player.name)
            : 0;
        if (panelStatsMode === 'event' && game.eventId) {
            const ps = (cachedPanelEventStats && cachedPanelEventStats[player.id]) || {};
            const eventTime = (ps.timePlayed || 0) + gameTime;
            timeCell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(eventTime)
                : '0:00';
        } else if (panelShowingTotalStats) {
            const totalTime = (player.totalTimePlayed || 0) + gameTime;
            timeCell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(totalTime)
                : '0:00';
        } else {
            timeCell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(gameTime)
                : '0:00';
        }
        row.appendChild(timeCell);

        // Point participation columns
        let runningPointTotal = 0;
        if (panelStatsMode === 'event' && game.eventId) {
            runningPointTotal = (cachedPanelEventStats && cachedPanelEventStats[player.id]?.pointsPlayed) || 0;
        } else if (panelShowingTotalStats) {
            runningPointTotal = player.pointsPlayedPreviousGames || 0;
        }
        game.points.forEach(point => {
            const pointCell = document.createElement('td');
            pointCell.classList.add('active-points-columns');
            // Include players who were substituted out mid-point (show both subbed-in and subbed-out)
            const playedFullPoint = point.players.includes(player.name);
            const subbedOutMidPoint = point.substitutedOutPlayers && point.substitutedOutPlayers.includes(player.name);
            const subbedInMidPoint = point.substitutedInPlayers && point.substitutedInPlayers.includes(player.name);
            const playedPoint = playedFullPoint || subbedOutMidPoint;
            if (playedPoint) {
                runningPointTotal++;
                pointCell.textContent = `${runningPointTotal}`;
                // Italic for a partial point: subbed out (didn't finish it)
                // or subbed in (joined it late).
                if (subbedOutMidPoint || subbedInMidPoint) {
                    pointCell.classList.add('point-cell-subbed-out');
                }
            } else {
                pointCell.textContent = '-';
            }
            row.appendChild(pointCell);
        });

        // On Deck: tentative-next projection — points played so far, +1 if this
        // player is slated for the immediate next point. Read-only/greyed; it's
        // a planning aid, not an editable column.
        if (isOnDeckView) {
            const projCell = document.createElement('td');
            projCell.classList.add('active-ondeck-projection');
            // Like every other point column: show the (incremented) running
            // total only for players slated for the immediate next point; a
            // dash for those sitting it out, matching the table's "-" idiom.
            if (tentativeNextSet.includes(player.name)) {
                projCell.textContent = `${runningPointTotal + 1}`;
            } else {
                projCell.textContent = '-';
            }
            row.appendChild(projCell);
        }

        tableBody.appendChild(row);
    });
    
    // Apply sticky columns
    requestAnimationFrame(() => {
        makePanelColumnsSticky();
    });
    
}

/**
 * Update only the time cells in the Select Line table
 * Lightweight function called every second during a point
 */
function updateSelectLineTimeCells() {
    const table = document.getElementById('panelActivePlayersTable');
    if (!table) return;
    
    // Body cells only — the controls header row also has an .active-time-column
    // cell (the Game/Event toggle); including it here would overwrite the toggle
    // and shift every player's time down by one row.
    const timeCells = table.querySelectorAll('tbody .active-time-column');
    if (timeCells.length === 0) return;

    // Get all checkboxes to map cells to players
    const checkboxes = table.querySelectorAll('tbody .active-checkbox');
    
    timeCells.forEach((cell, index) => {
        const checkbox = checkboxes[index];
        if (!checkbox) return;
        
        const playerName = checkbox.dataset.playerName;
        if (!playerName) return;
        
        // Find the player in the roster
        const activeRoster = typeof getActiveRoster === 'function' ? getActiveRoster() : currentTeam?.teamRoster;
        const player = activeRoster?.find(p => p.name === playerName);
        if (!player) return;

        const gameTime = typeof getPlayerGameTime === 'function'
            ? getPlayerGameTime(playerName)
            : 0;

        // Calculate time based on current display mode
        if (panelStatsMode === 'event') {
            const game = typeof currentGame === 'function' ? currentGame() : null;
            if (game && game.eventId) {
                const ps = (cachedPanelEventStats && cachedPanelEventStats[playerName]) || {};
                const eventTime = (ps.timePlayed || 0) + gameTime;
                cell.textContent = typeof formatPlayTime === 'function'
                    ? formatPlayTime(eventTime)
                    : '0:00';
            }
        } else if (panelShowingTotalStats) {
            const totalTime = (player.totalTimePlayed || 0) + gameTime;
            cell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(totalTime)
                : '0:00';
        } else {
            cell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(gameTime)
                : '0:00';
        }
    });
}

/**
 * Render the "Line Coach: viewing/editing the X line" awareness label on
 * the Active Coach's Select Line panel.
 *
 * Reads the synced lineCoachViewing field (written only by the LC via
 * noteLineCoachViewing) and compares against the AC's local activeType.
 * Per TODO design, the label is hidden in three cases:
 *   (a) AC's local view already matches the LC's view (no new info).
 *   (b) No LC role is currently claimed.
 *   (c) AC and LC are the same user (solo / dual-role).
 * Additionally only rendered for the Active Coach — the LC themselves
 * has no use for it.
 *
 * Viewing vs editing distinction: if any line *ModifiedAt is within the
 * last ~10s, the verb is "editing" (stronger nudge for the AC to look);
 * otherwise "viewing".
 */
function updateLineCoachViewingLabel() {
    const el = document.getElementById('selectLineLcViewing');
    if (!el) return;

    const hide = () => {
        el.style.display = 'none';
        el.textContent = '';
    };

    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) { hide(); return; }

    const ctrl = (typeof getControllerState === 'function') ? getControllerState() : {};

    // (b) No LC claimed → nothing to label.
    if (!ctrl.lineCoach) { hide(); return; }
    // (c) Same user holds both roles → no awareness gap.
    if (ctrl.activeCoach && ctrl.lineCoach.userId === ctrl.activeCoach.userId) {
        hide(); return;
    }
    // Only render for the Active Coach. The Line Coach already knows their
    // own view; viewers see the AC's view per existing design.
    if (!ctrl.isActiveCoach) { hide(); return; }

    const lcView = game.pendingNextLine.lineCoachViewing;
    if (!lcView) { hide(); return; }

    // (a) AC's local view already matches LC's view → no signal to convey.
    const localView = game.pendingNextLine.activeType || 'od';
    if (lcView === localView) { hide(); return; }

    // Pick verb based on recent line-edit activity (any axis).
    const now = Date.now();
    const recentEdit = ['oLineModifiedAt', 'dLineModifiedAt', 'odLineModifiedAt'].some((k) => {
        const t = game.pendingNextLine[k] ? new Date(game.pendingNextLine[k]).getTime() : 0;
        return t && (now - t) < 10000;
    });
    const verb = recentEdit ? 'editing' : 'viewing';

    const viewLabels = {
        o: 'the O line', d: 'the D line', od: 'the O/D line',
        odOnDeck: 'the On Deck line', split: 'split (O & D)'
    };
    const targetLabel = viewLabels[lcView] || `the ${lcView} line`;
    const lcName = (ctrl.lineCoach.displayName) || 'Line Coach';

    el.textContent = `${lcName}: ${verb} ${targetLabel}`;
    el.style.display = '';
}

/**
 * Update the Select Line panel subtitle (shown in title bar when minimized)
 * Shows the selected player names as a compact, comma-separated list
 */
function updateSelectLineSubtitle() {
    // Keep the LC-viewing awareness label in sync on every subtitle refresh —
    // updateSelectLineSubtitle is already invoked at every panel lifecycle
    // moment (toggle, point end, cloud refresh, etc.) so piggy-backing here
    // avoids new wiring.
    updateLineCoachViewingLabel();

    if (typeof setPanelSubtitle !== 'function') return;

    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game) {
        setPanelSubtitle('selectLine', '');
        return;
    }
    
    // Get current pending selections
    const pendingLine = game.pendingNextLine || {};
    const activeType = pendingLine.activeType || 'od';
    const lineKey = activeType + 'Line';
    const selectedNames = pendingLine[lineKey] || [];
    
    // Update panel title based on line type: "Next D Line", "Next O Line", "Next Line", or "On Deck Line"
    const titleLabels = { o: 'Next O Line', d: 'Next D Line', od: 'Next Line', odOnDeck: 'On Deck Line', split: 'Next Line' };
    const panelTitle = titleLabels[activeType] || 'Next Line';
    if (typeof setPanelTitle === 'function') {
        setPanelTitle('selectLine', panelTitle);
    }
    
    if (selectedNames.length === 0) {
        setPanelSubtitle('selectLine', '(no players selected)');
        return;
    }
    
    // Get first names only for compactness
    const firstNames = selectedNames.map(name => name.split(' ')[0]);
    
    // Join with commas - CSS text-overflow: ellipsis handles truncation based on actual width
    const playerList = firstNames.join(', ');
    
    // Subtitle is just the player names (type is now in the title)
    setPanelSubtitle('selectLine', playerList);
}

/**
 * Enable axis-locked scrolling on a table container.
 * After the touch moves past a threshold, classifies the gesture as
 * horizontal or vertical, then takes over scrolling via preventDefault()
 * and manual scrollLeft/scrollTop updates on the locked axis only.
 * Only attaches listeners once per container (idempotent).
 * @param {HTMLElement} container - The .select-line-table-container element
 */
function enableAxisLockedScroll(container) {
    if (container._axisLockAttached) return;
    container._axisLockAttached = true;

    let startX, startY, lastX, lastY, axis; // axis: null | 'h' | 'v'
    const THRESHOLD = 8;

    let onStickyColumn;

    container.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        startX = lastX = touch.clientX;
        startY = lastY = touch.clientY;
        axis = null;
        // Check if touch started on a sticky column — those use native pan-y
        onStickyColumn = !!e.target.closest(
            '.active-checkbox-column, .active-name-column, .active-time-column, .active-checkbox, .active-header-teams'
        );
    }, { passive: true });

    // Non-passive so we can preventDefault() once axis is locked
    container.addEventListener('touchmove', (e) => {
        if (!e.touches.length || onStickyColumn) return;
        const touch = e.touches[0];

        if (!axis) {
            const dx = Math.abs(touch.clientX - startX);
            const dy = Math.abs(touch.clientY - startY);
            if (dx >= THRESHOLD || dy >= THRESHOLD) {
                axis = (dx > dy * 2) ? 'h' : 'v';
            } else {
                return; // not enough movement yet
            }
        }

        // Take over scrolling — prevent browser's default diagonal scroll
        e.preventDefault();
        const moveX = lastX - touch.clientX;
        const moveY = lastY - touch.clientY;
        lastX = touch.clientX;
        lastY = touch.clientY;

        if (axis === 'h') {
            container.scrollLeft += moveX;
        } else {
            container.scrollTop += moveY;
        }
    }, { passive: false });

    container.addEventListener('touchend', () => { axis = null; }, { passive: true });
    container.addEventListener('touchcancel', () => { axis = null; }, { passive: true });
}

/**
 * Width-sync the Line tab's sticky columns and restore horizontal scroll.
 * Position, colors, box-shadow borders, z-index, and touch-action are static
 * CSS (see the #panelActivePlayersTable .active-* rules in ui/panelSystem.css)
 * — this only sets the name/time columns' `left` offsets, which depend on the
 * measured checkbox/name column widths that CSS can't derive on its own.
 */
function makePanelColumnsSticky() {
    const checkboxCells = document.querySelectorAll('#panelActivePlayersTable .active-checkbox-column');
    const nameCells = document.querySelectorAll('#panelActivePlayersTable .active-name-column');
    const timeCells = document.querySelectorAll('#panelActivePlayersTable .active-time-column');

    if (checkboxCells.length === 0) return;

    // Get widths
    const checkboxWidth = checkboxCells[0].getBoundingClientRect().width || 30;
    const nameWidth = nameCells.length > 0 ? nameCells[0].getBoundingClientRect().width : 0;

    // Offset name column to sit right after the checkbox column
    nameCells.forEach(cell => {
        cell.style.left = `${checkboxWidth}px`;
    });

    // Offset time column to sit right after the name column
    timeCells.forEach(cell => {
        cell.style.left = `${checkboxWidth + nameWidth}px`;
    });

    // Restore the user's horizontal scroll position. Snap to the right edge
    // (most recent points) only on first render or when the user was already
    // following the latest; otherwise preserve where they scrolled to so the
    // periodic rebuild doesn't pop them back to the right (see _selectLineScrollState).
    const tableContainer = document.getElementById('panelTableContainer');
    if (tableContainer) {
        if (_selectLineScrollState && !_selectLineScrollState.atRightEdge) {
            tableContainer.scrollLeft = _selectLineScrollState.scrollLeft;
        } else {
            tableContainer.scrollLeft = tableContainer.scrollWidth;
        }
        enableAxisLockedScroll(tableContainer);
    }
}


/**
 * Full update of the Select Line panel
 * Called when entering game screen or game state changes
 */
function updateSelectLinePanel() {
    updateSelectLineTable();
    updateSelectLinePanelState();
    updateODToggleButton();
}

// Setters for module-scoped mutable state — converted writers
// (game/gameScreenSync.js, game/gameScreenEvents.js) import these instead of
// assigning the bare globals.
function setPanelStatsMode(v) { panelStatsMode = v; }
function setPanelShowingTotalStats(v) { panelShowingTotalStats = v; }
function setCachedPanelEventStats(v) { cachedPanelEventStats = v; }
function setLastConflictToastPointIndex(v) { lastConflictToastPointIndex = v; }

// --- ES-module exports ---
export {
    wireSelectLineEvents,
    clearLineSelection, autoFillLineSelection,
    computeAutoLine, buildAutoLineStats,
    handlePanelStartPoint, checkPanelGenderRatio,
    getSelectedPlayersFromPanel, getEffectiveLineForNextPoint,
    selectAppropriateLineAtPointEnd, autoSelectActiveTypeForNextPoint,
    showGameUpdatedToast,
    updateSelectLinePanel, updateSelectLinePanelState, updateSelectLineTable,
    updateSelectLineTimeCells,
    setPanelStatsMode, setPanelShowingTotalStats,
    setCachedPanelEventStats, setLastConflictToastPointIndex,
};
// window survivor: late-bound back-edge hook (called by
// game/pointManagement.js, which evaluates before this file)
window.getEffectiveLineForNextPoint = getEffectiveLineForNextPoint;
// window survivor: late-bound back-edge hook (called by
// teams/rosterManagement.js, which evaluates before this file)
window.updateSelectLinePanel = updateSelectLinePanel;
// window survivor: debug seam — Auto-line logic exercisable from the dev
// console (see the buildAutoLineStats doc comment)
window.computeAutoLine = computeAutoLine;
// window survivor: debug seam (paired with computeAutoLine above)
window.buildAutoLineStats = buildAutoLineStats;
// Dropped shims (zero external references found): updateSelectLineTable,
// updateSelectLinePanelState, updateSelectLineSubtitle, canEditSelectLinePanel,
// savePanelSelectionsToPendingNextLine.
