/*
 * Game screen — lifecycle, log/score updates, role buttons & cloud/controller sync.
 * enter/exit game screen, game-log/score panel updates, role-button state, the
 * cloud game-state refresh loop, and the controller-state UI integration (a
 * 'breakside:controller-ui-updated' listener; controllerState.js dispatches it
 * at the end of updateControllerUI — replaced the old monkey-patch wrapper).
 * Split from the former monolithic gameScreen.js (refactor, no behavior change).
 */
import { Role } from '../store/models.js';
import {
    currentTeam, currentEvent, setCurrentEvent, deserializeTournamentEvent,
} from '../store/storage.js';
import { currentGame, isPointInProgress } from '../utils/helpers.js';
import { normalizeStamp, stampSaysChanged } from '../utils/changeStamp.js';
import {
    listTeamEvents, refreshPendingLineFromCloud, refreshGameStateFromCloud,
    fetchGameStamp,
} from '../store/sync.js';
import {
    isGameScreenVisible, showGameScreen, hideGameScreen, resetAllPanelStates,
    getPanelState, setPanelState, MIN_PANEL_HEIGHT, updatePanelsForRole,
    resetMultiCoachDetected,
} from '../ui/panelSystem.js';
import { startActiveGamePolling, stopActiveGamePolling } from '../teams/activeGamePolling.js';
import { powerManager } from '../utils/powerManager.js';
import { showSelectTeamScreen } from '../teams/teamList.js';
import {
    getControllerState, getCurrentUserId, startControllerPolling,
    stopControllerPolling, showControllerToast, dismissToast, getPingGameStamp,
} from './controllerState.js';
import { summarizeGame } from './gameLogic.js';
import { renderGameLogHTML, escapeHtml } from '../utils/gameLogRenderer.js';
import {
    initGameScreen, gameScreenInitialized, updateHeaderTeamIdentities,
} from './gameScreenPanels.js';
import {
    ensureDialogVisible, setupPlayByPlayResizeObserver, updatePlayByPlayPanelState,
} from './gameScreenEvents.js';
import {
    updateTimerDisplay, updateTimerPauseButton, startGameScreenTimerLoop,
    stopGameScreenTimerLoop, setPointTimerPaused,
} from './gameTimer.js';
import {
    updateSelectLinePanel, updateSelectLinePanelState, updateSelectLineTable,
    autoSelectActiveTypeForNextPoint, showGameUpdatedToast,
    setPanelStatsMode, setPanelShowingTotalStats, setCachedPanelEventStats,
} from './selectLine.js';
import { log } from '../utils/logger.js';

// =============================================================================
// UI Updates
// =============================================================================

/**
 * Update the score display in the header
 * @param {number} usScore - Our team's score
 * @param {number} themScore - Opponent's score
 */
function updateGameScreenScore(usScore, themScore) {
    const usEl = document.getElementById('gameScoreUs');
    const themEl = document.getElementById('gameScoreThem');
    
    if (usEl) usEl.textContent = usScore;
    if (themEl) themEl.textContent = themScore;

    // Also update game log score (reads current score from the game itself)
    updateGameLogTitleScore();
}

// =============================================================================
// Game Log Panel Updates
// =============================================================================

/**
 * Update the Game Log title bar with live score.
 * Format: "TeamName 5 – OppName 2"
 * If the text overflows, collapses to short names:
 *   Our team: currentTeam.teamSymbol (4-char, e.g. "BRK") — skip if null
 *   Opponent: "Opp."
 */
function updateGameLogTitleScore() {
    const titleTextEl = document.querySelector('#panel-follow-title .panel-title-text');
    if (!titleTextEl) return;

    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }

    if (!game) {
        titleTextEl.textContent = 'Game Log';
        return;
    }

    const teamName = game.team || 'Us';
    const opponentName = game.opponent || 'Them';
    const usScore = game.scores ? game.scores[Role.TEAM] : 0;
    const themScore = game.scores ? game.scores[Role.OPPONENT] : 0;

    const fullText = `${teamName} ${usScore} – ${opponentName} ${themScore}`;
    titleTextEl.textContent = fullText;

    // Check for overflow and collapse names if needed
    if (titleTextEl.scrollWidth > titleTextEl.clientWidth) {
        const shortTeam = (typeof currentTeam !== 'undefined' && currentTeam && currentTeam.teamSymbol)
            ? currentTeam.teamSymbol
            : teamName;
        const shortOpp = 'Opp.';
        titleTextEl.textContent = `${shortTeam} ${usScore} – ${shortOpp} ${themScore}`;
    }
}

/**
 * Update the Game Log panel event list
 * Uses summarizeGame() to get the game summary text
 */
function updateGameLogEvents() {
    const eventsEl = document.getElementById('gameLogEvents');
    if (!eventsEl) return;
    
    // Check if game screen is visible
    if (!isGameScreenVisible()) return;
    
    // Get game summary
    let summary = '';
    if (typeof summarizeGame === 'function') {
        summary = summarizeGame();
    }
    
    if (!summary || summary.trim() === '') {
        // Show placeholder when no events
        eventsEl.innerHTML = `
            <div class="game-log-placeholder">
                <i class="fas fa-list"></i>
                <span>Game events will appear here</span>
            </div>
        `;
        return;
    }
    
    // Format the summary for display — line classification + escaping live in
    // the shared renderer (utils/gameLogRenderer.js, G6 merge).
    const html = renderGameLogHTML(summary, getTeamName());

    // Only update DOM and auto-scroll if content actually changed
    if (eventsEl.innerHTML !== html) {
        eventsEl.innerHTML = html;
        // Auto-scroll to bottom only when new content arrives
        eventsEl.scrollTop = eventsEl.scrollHeight;
    }
}

/**
 * Get the team name for display
 * @returns {string}
 */
function getTeamName() {
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    return game?.team || 'Us';
}

/**
 * Full update of the Game Log panel
 * Call this when entering game screen or when game changes significantly
 */
function updateGameLogPanel() {
    updateGameLogTitleScore();
    updateGameLogEvents();
}

/**
 * Update role button states in the game screen
 * Called when controller state changes
 * @param {object} state - Controller state
 */
// Track the "no roles" warning toast so we can dismiss it when a role is claimed
let noRolesWarningToast = null;
// Track when we entered the game screen to delay the warning toast
let gameScreenEnteredAt = null;
const NO_ROLES_WARNING_DELAY_MS = 3000; // Wait 3 seconds before showing warning

function updateGameScreenRoleButtons(state) {
    const activeBtn = document.getElementById('gameActiveCoachBtn');
    const lineBtn = document.getElementById('gameLineCoachBtn');
    const activeHolder = document.getElementById('gameActiveCoachHolder');
    const lineHolder = document.getElementById('gameLineCoachHolder');
    
    if (!activeBtn || !lineBtn) return;
    
    const myUserId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : null;
    
    // Update Active Coach button
    const iAmActiveCoach = state.activeCoach?.userId === myUserId;
    activeBtn.classList.remove('has-role', 'other-has-role', 'pending-handoff', 'role-available');
    
    if (iAmActiveCoach) {
        // I explicitly have this role
        activeBtn.classList.add('has-role');
        if (activeHolder) activeHolder.textContent = 'You';
    } else if (state.pendingHandoff?.role === 'activeCoach' && state.pendingHandoff?.requesterId === myUserId) {
        // I've requested this role
        activeBtn.classList.add('pending-handoff');
        if (activeHolder) activeHolder.textContent = 'Requesting...';
    } else if (state.activeCoach) {
        // Someone else has this role
        activeBtn.classList.add('other-has-role');
        if (activeHolder) activeHolder.textContent = state.activeCoach.displayName || 'Someone';
    } else {
        // Role is unclaimed - show as available
        activeBtn.classList.add('role-available');
        if (activeHolder) activeHolder.textContent = 'Available';
    }
    
    // Update Line Coach button
    const iAmLineCoach = state.lineCoach?.userId === myUserId;
    lineBtn.classList.remove('has-role', 'other-has-role', 'pending-handoff', 'role-available');
    
    if (iAmLineCoach) {
        // I explicitly have this role
        lineBtn.classList.add('has-role');
        if (lineHolder) lineHolder.textContent = 'You';
    } else if (state.pendingHandoff?.role === 'lineCoach' && state.pendingHandoff?.requesterId === myUserId) {
        // I've requested this role
        lineBtn.classList.add('pending-handoff');
        if (lineHolder) lineHolder.textContent = 'Requesting...';
    } else if (state.lineCoach) {
        // Someone else has this role
        lineBtn.classList.add('other-has-role');
        if (lineHolder) lineHolder.textContent = state.lineCoach.displayName || 'Someone';
    } else {
        // Role is unclaimed - show as available
        lineBtn.classList.add('role-available');
        if (lineHolder) lineHolder.textContent = 'Available';
    }
    
    // Show warning toast when both roles become unclaimed (once per transition)
    // Delay showing the warning to allow auto-assign to happen on first join
    const bothUnclaimed = !state.activeCoach && !state.lineCoach;
    const timeSinceEntry = gameScreenEnteredAt ? (Date.now() - gameScreenEnteredAt) : 0;
    const delayElapsed = timeSinceEntry >= NO_ROLES_WARNING_DELAY_MS;
    
    if (bothUnclaimed && !noRolesWarningToast && delayElapsed) {
        if (typeof showControllerToast === 'function') {
            noRolesWarningToast = showControllerToast('No coach has claimed a role. Tap a role to claim it.', 'warning', 0);
        }
    } else if (!bothUnclaimed && noRolesWarningToast) {
        // Dismiss the warning toast when someone claims a role
        if (typeof dismissToast === 'function') {
            dismissToast(noRolesWarningToast);
        }
        noRolesWarningToast = null;
    }
}

// =============================================================================
// Game Screen Entry Point
// =============================================================================

/**
 * Enter the new game screen UI
 * Called when starting a point or entering a game
 */
function enterGameScreen() {
    // Tell the power manager we're in a game: this gates the in-game polling
    // loops and is what makes the screen wake lock acquire.
    powerManager.setGameActive(true);

    // Reset stats mode (module-scoped state owned by game/selectLine.js —
    // written via its exported setters)
    setPanelStatsMode('game');
    setPanelShowingTotalStats(false);
    setCachedPanelEventStats(null);

    // Set currentEvent if game is part of an event. Refetch when it's missing
    // OR points at a different event than this game, so the Line tab always
    // reflects the latest per-event position/line overrides (getEffective*
    // read currentEvent). Same-event edits are also pushed into currentEvent
    // synchronously by saveEventRoster, so this best-effort async fetch is a
    // backstop rather than the only path.
    const currentGameObj = typeof currentGame === 'function' ? currentGame() : null;
    if (currentGameObj && currentGameObj.eventId
        && (!currentEvent || currentEvent.id !== currentGameObj.eventId)) {
        // Try to fetch event data (best effort — will be null if not loaded)
        if (typeof listTeamEvents === 'function' && currentGameObj.teamId) {
            listTeamEvents(currentGameObj.teamId).then(events => {
                const ev = events.find(e => e.id === currentGameObj.eventId);
                if (ev) {
                    setCurrentEvent(typeof deserializeTournamentEvent === 'function'
                        ? deserializeTournamentEvent(ev) : ev);
                }
            }).catch(() => {});
        }
    }

    // Stop active-game polling while in a game
    if (typeof stopActiveGamePolling === 'function') {
        stopActiveGamePolling();
    }

    // Reset panel layout on every game entry so stale heights/hidden
    // states from previous sessions don't persist across games.
    if (typeof resetAllPanelStates === 'function') {
        resetAllPanelStates();
    }

    // Initialize if needed
    if (!gameScreenInitialized) {
        initGameScreen();
    }
    
    // Move dialogs to body so they can be displayed above the game screen
    // These dialogs are children of simpleModeScreen which gets hidden
    ensureDialogVisible('scoreAttributionDialog');
    ensureDialogVisible('keyPlayDialog');
    
    // Show the game screen
    showGameScreen();
    
    // Reset the "no roles" warning toast reference so it can show again for this game session
    noRolesWarningToast = null;
    gameScreenEnteredAt = Date.now();
    
    // Reset timer pause state when entering (state owned by game/gameTimer.js)
    setPointTimerPaused(false);
    
    // Update displays
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    if (game) {
        // Update score
        const usScore = game.scores ? game.scores[Role.TEAM] : 0;
        const themScore = game.scores ? game.scores[Role.OPPONENT] : 0;
        updateGameScreenScore(usScore, themScore);
        
        // Start controller polling for this game
        if (game.id && typeof startControllerPolling === 'function') {
            startControllerPolling(game.id);
        }
    }
    
    // Update team identities in header
    updateHeaderTeamIdentities();
    
    // Update timer display and pause button
    updateTimerDisplay();
    updateTimerPauseButton();
    
    // Start timer updates
    startGameScreenTimerLoop();
    
    // Start game state refresh for syncing with other clients
    startGameStateRefresh();
    
    // Update game log panel
    updateGameLogPanel();
    
    // Update role buttons from controller state
    if (typeof getControllerState === 'function') {
        const state = getControllerState();
        updateGameScreenRoleButtons(state);
        updatePanelsForRole();
    }
    
    // Update Play-by-Play panel state (based on role only)
    updatePlayByPlayPanelState();
    
    // Update Select Next Line panel
    updateSelectLinePanel();

    // Pin selectLine at a reasonable height so it doesn't start at ~0
    // (which causes the game log to overlap it before flex layout settles).
    // Cap at 45% of container to ensure follow (game log) stays visible.
    requestAnimationFrame(() => {
        const slPanel = document.getElementById('panel-selectLine');
        const slState = typeof getPanelState === 'function' ? getPanelState('selectLine') : null;
        if (slPanel && slState && !slState.height) {
            const container = document.getElementById('gameScreenContainer');
            const maxHeight = container ? Math.floor(container.clientHeight * 0.45) : 300;
            const measured = slPanel.getBoundingClientRect().height;
            if (measured > MIN_PANEL_HEIGHT) {
                setPanelState('selectLine', { height: Math.min(measured, maxHeight) });
            }
        }
    });

    // Set up ResizeObserver for Play-by-Play panel layout
    setupPlayByPlayResizeObserver();

    // The mic button's visibility used to be discovered by a 2×/sec poll;
    // enter/exit now tell it directly. Called here, after showGameScreen(),
    // because it reads the game screen's DOM class.
    window.narrationMicButton?.refreshVisibility?.();

    log('🎮 Entered game screen');
}

/**
 * Exit the game screen UI
 * Returns to legacy navigation
 */
function exitGameScreen() {
    hideGameScreen();
    stopGameScreenTimerLoop();
    stopGameStateRefresh();

    // Closes out the wake lock and stops the in-game loops.
    powerManager.setGameActive(false);
    window.powerLog?.sampleBattery?.('game-exit');
    // The mic button's visibility used to be discovered by a 2×/sec poll;
    // enter/exit now tell it directly.
    window.narrationMicButton?.refreshVisibility?.();

    // Clear event context when leaving game (state owned by store/storage.js
    // and game/selectLine.js — written via their exported setters)
    setCurrentEvent(null);
    setCachedPanelEventStats(null);

    // Reset multi-coach detection for next game
    if (typeof resetMultiCoachDetected === 'function') {
        resetMultiCoachDetected();
    }

    // Resume active-game polling when leaving a game
    if (typeof startActiveGamePolling === 'function') {
        startActiveGamePolling();
    }

    log('🎮 Exited game screen');
}

// =============================================================================
// Integration with Controller State
// =============================================================================

// Track game state refresh interval
let gameStateRefreshIntervalId = null;

// =============================================================================
// Change gating
// =============================================================================
//
// This loop used to pull GET /api/games/{id} — the entire game, every point
// and every event — every 3 seconds, whether or not anything had changed.
// Twenty full payloads a minute per device, for a game state that only moves
// when a coach records something. The radio never got to idle, and the radio
// tail is where the battery actually goes.
//
// So the loop now asks a cheap question first: has the server's copy changed
// since the one we already hold? The answer is a change stamp
// (current.json's mtime), and there are two ways to get one:
//
//   - From the controller ping. It already runs every 2s and now carries
//     `gameStamp`, so for any coach in a game this costs *nothing* — the
//     3s loop makes zero requests while the game is idle.
//   - From GET /api/games/{id}/poll, ~30 bytes. Only for in-game clients
//     that never ping (viewers), and for the gap right after a resume.
//
// A null stamp anywhere in the chain means "no opinion" and falls through to
// an unconditional refresh: an old server that doesn't send the field, a
// failed request, a ping that hasn't landed yet. Stale-but-working beats
// clever-but-silent.

/**
 * The stamp of the game state we last pulled, or null for "unknown — pull".
 * Reset whenever the game screen is entered or left, because a stamp from a
 * previous session says nothing about what we hold now.
 * @type {string|null}
 */
let lastRefreshedStamp = null;

/**
 * The game the refresh loop is currently installed for, so the stamp-change
 * event knows what to refresh. Null when the loop isn't running.
 * @type {string|null}
 */
let refreshGameId = null;

/**
 * Guards against two refreshes overlapping — the 3s tick and the ping's
 * stamp-change event are independent triggers.
 * @type {boolean}
 */
let refreshInFlight = false;

/**
 * The current server stamp for a game, as cheaply as this client can get it.
 * @param {string} gameId
 * @returns {Promise<string|null>} null = unknown, treat as changed
 */
async function currentGameStamp(gameId) {
    // Free: the ping is already running for every coach in a game.
    const fromPing = getPingGameStamp(gameId);
    if (fromPing) return fromPing;

    // Viewers hold no controller session and never ping, so they pay for a
    // stamp — still ~200x smaller than the game they'd otherwise pull.
    return await fetchGameStamp(gameId);
}

/**
 * Whether the server's game state differs from the copy we last pulled.
 *
 * Reads the stamp *before* the caller fetches, never after. A write landing
 * between the two makes us record the older stamp and refetch once more next
 * tick — wasteful but correct. Recording the newer one would mean marking a
 * change as seen that we never actually pulled, which is a lost update.
 *
 * @param {string} gameId
 * @returns {Promise<{changed: boolean, stamp: string|null}>}
 */
async function gameStateChanged(gameId) {
    const stamp = normalizeStamp(await currentGameStamp(gameId));
    return { changed: stampSaysChanged(lastRefreshedStamp, stamp), stamp };
}

/**
 * Start periodic refresh of game state from cloud.
 * - Active Coach: Only refresh pending line (they push game data, not pull)
 * - Everyone else: Refresh full game state (scores, points, events)
 *
 * Gated on a change stamp (see above), so an idle game costs no network at
 * all for a coach and one tiny poll for a viewer.
 */
function startGameStateRefresh() {
    if (gameStateRefreshIntervalId) {
        return; // Already running
    }
    
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.id) {
        return;
    }
    
    const gameId = game.id;
    refreshGameId = gameId;

    // Every (re)start is a fresh claim: game entry, a different game, resume
    // after the power manager stopped us, and the wake-recovery restart all
    // land here. Forgetting the stamp makes the first pull unconditional,
    // which is what "refetch on the first ping after a resume" means in
    // practice — we can't trust a stamp from before a sleep.
    lastRefreshedStamp = null;

    // Tick every 3 seconds. The tick itself is nearly free now: for a coach it
    // reads the stamp the ping already cached and usually stops there. It is
    // the safety net; the ping's stamp-change event below is the fast path.
    gameStateRefreshIntervalId = setInterval(() => {
        window.powerLog?.countWakeup?.('gameStateRefresh');
        // Stop if no longer visible
        if (!isGameScreenVisible()) {
            stopGameStateRefresh();
            return;
        }
        refreshGameStateIfChanged(gameId);
    }, 3000);

    log('🔄 Started game state refresh polling');
}

/**
 * Pull and apply the game state, but only if the server's copy has moved.
 *
 * Serialized on `refreshInFlight`: the ping's stamp event and the 3s tick both
 * call this, and a slow network could otherwise have two pulls racing to claim
 * the same stamp.
 *
 * @param {string} gameId
 */
async function refreshGameStateIfChanged(gameId) {
    if (refreshInFlight) return;
    // Claim the guard before the first await, not after: on the viewer path
    // the stamp check is itself a network round-trip, and two callers that
    // both got past an unclaimed guard would race from there.
    refreshInFlight = true;
    try {
        // Nothing changed on the server since our last pull — skip the whole
        // refresh. For a coach this costs no network at all.
        const { changed, stamp } = await gameStateChanged(gameId);
        if (!changed) return;

        // Claim the stamp before fetching, not after — see gameStateChanged.
        lastRefreshedStamp = stamp;
        await applyGameStateRefresh(gameId);
    } finally {
        refreshInFlight = false;
    }
}

/**
 * The refresh itself, once we know there is something to pull.
 * @param {string} gameId
 */
async function applyGameStateRefresh(gameId) {
    // Check if we're the Active Coach
    const state = typeof getControllerState === 'function' ? getControllerState() : {};
    const isActiveCoach = state.isActiveCoach;

    if (isActiveCoach) {
        // Active Coach: refresh the pending line continuously, including
        // during a live point. Originally gated on !isPointInProgress()
        // to protect mid-point edits from being clobbered by Line Coach
        // syncs — that risk was eliminated by the server-side per-field
        // merge + non-authoritative writer guard (commit 9fadda1), so
        // the gate can now go. With it gone, the AC sees the LC's view
        // switches and line edits live, which is what the LC-viewing
        // sub-header (rendered below) needs to stay accurate.
        if (typeof refreshPendingLineFromCloud === 'function') {
            // Snapshot lineupReadyAt before refresh so we can
            // detect a *new* "Lineup Ready" ping from the Line
            // Coach. The merge happens in-place inside the
            // refresh function; comparing pre/post tells us
            // whether to surface a toast.
            const gameForSnapshot = (typeof currentGame === 'function') ? currentGame() : null;
            const prevLineupReadyAt = (gameForSnapshot
                && gameForSnapshot.pendingNextLine
                && gameForSnapshot.pendingNextLine.lineupReadyAt) || 0;

            const result = await refreshPendingLineFromCloud(gameId);
            // `false` means the pull never reached the server. Give the
            // stamp back so the next tick retries — otherwise one
            // transient failure strands us on stale state until some
            // other coach happens to write.
            if (result === false) lastRefreshedStamp = null;
            if (result && typeof result === 'object' && result.gameJustEnded) {
                // Game ended by another session/device
                log('🏁 Game ended by another session — leaving game screen');
                if (typeof showControllerToast === 'function') {
                    showControllerToast('Game has ended', 'info', 4000);
                }
                stopControllerPolling();
                exitGameScreen();
                if (typeof showSelectTeamScreen === 'function') {
                    showSelectTeamScreen();
                }
                return;
            }
            if (result) {
                // Re-evaluate which line will be used for the
                // next point now that we have fresh data — but
                // ONLY between points. autoSelect overrides
                // activeType to whatever the Intent Rule picks,
                // which is the right behavior at point-end (snap
                // the AC's view to the line that will actually
                // start) but the wrong behavior mid-point: a
                // manual O|D toggle by the AC or LC gets reverted
                // on the next 3s poll. The refresh-gate removal
                // (this commit's parent) is for keeping line
                // *data* and the LC-viewing label fresh during a
                // point — not for forcing view auto-selection.
                const pointInProgress = typeof isPointInProgress === 'function'
                    && isPointInProgress();
                if (!pointInProgress
                    && typeof autoSelectActiveTypeForNextPoint === 'function') {
                    autoSelectActiveTypeForNextPoint();
                }
                updateSelectLinePanel();

                // Refresh PBP-side button state too. updateSelect-
                // LinePanel only touches the Line tab's table —
                // the Start Point buttons on Simple, Full, AND
                // Line tabs all read from updatePlayByPlayPanel-
                // State. Without this, the Active Coach who's
                // sitting on Full or Simple sees stale button
                // colors (and the Line tab's own button doesn't
                // refresh either, since its state is hung off
                // updatePlayByPlayPanelState via
                // updateLineTabStartPointBtn).
                if (typeof updatePlayByPlayPanelState === 'function') {
                    updatePlayByPlayPanelState();
                }

                // Surface a Lineup Ready ping if this refresh
                // brought one. Skip if the timestamp is stale
                // (>60s old) — could be a leftover from a
                // previous between-points window that we just
                // happened to refresh into now.
                const newReadyAt = (result && result.lineupReadyAt) || 0;
                if (newReadyAt > prevLineupReadyAt
                    && (Date.now() - newReadyAt) < 60000) {
                    const who = (result.lineupReadyBy || 'Line Coach');
                    if (typeof showControllerToast === 'function') {
                        showControllerToast(`${who} says lineup ready`, 'success', 4000);
                    }
                }
            }
        }
    } else {
        // Line Coach / Viewer: Refresh full game state
        if (typeof refreshGameStateFromCloud === 'function') {
            const result = await refreshGameStateFromCloud(gameId);
            // Same deal as the Active Coach branch: nothing was applied,
            // so we have no claim on the stamp we just recorded.
            if (!result.refreshed) lastRefreshedStamp = null;
            if (result.refreshed) {
                // Game ended by another coach — navigate away
                if (result.gameJustEnded) {
                    log('🏁 Game ended by another coach — leaving game screen');
                    if (typeof showControllerToast === 'function') {
                        showControllerToast('Game has ended', 'info', 4000);
                    }
                    stopControllerPolling();
                    exitGameScreen();
                    if (typeof showSelectTeamScreen === 'function') {
                        showSelectTeamScreen();
                    }
                    return;
                }

                // Update all UI elements
                updateGameScreenAfterRefresh();

                // Show conflict toast when another coach made meaningful changes
                // (skip for viewers — they expect live updates)
                const isViewerUser = typeof window.isViewer === 'function' && window.isViewer();
                if (!isViewerUser && (result.scoreChanged || result.pointCountChanged)) {
                    showGameUpdatedToast(result);
                }
            }
        }
    }
}

/**
 * Stop periodic refresh of game state
 */
function stopGameStateRefresh() {
    if (gameStateRefreshIntervalId) {
        clearInterval(gameStateRefreshIntervalId);
        gameStateRefreshIntervalId = null;
        refreshGameId = null;
        log('⏹️ Stopped game state refresh polling');
    }
}

// The fast path. controllerState.js fires this when a ping comes back with a
// game stamp different from the one the previous ping reported, so a coach
// sees another coach's write about as fast as their own ping cadence (≤2s)
// rather than waiting out the next 3s tick. That makes this change a latency
// *improvement* over the old unconditional poll, not just a battery one —
// which matters because the Active Coach's pendingNextLine merge depends on
// seeing Line Coach edits promptly (TODO.md § Multi-Coach Line Selection).
document.addEventListener('breakside:game-stamp-changed', (e) => {
    if (!refreshGameId || !isGameScreenVisible()) return;
    // A stamp for some other game says nothing about ours. Without this the
    // mid-switch case would fall through to a pointless /poll for our game —
    // harmless, but the guard is cheaper than the request.
    if (e.detail?.gameId !== refreshGameId) return;
    refreshGameStateIfChanged(refreshGameId);
});

// Power plan: this is a 3s network poll, so it's one of the two loops that
// matter most while the phone is pocketed. Both calls are idempotent.
//
// On resume this races with controllerState.js's wake-recovery handler, which
// deliberately stops the refresh, re-fetches game state, and restarts it. That
// ordering is fine — recovery's restart is the authoritative one; starting here
// covers the paths where recovery early-returns (e.g. no controller session).
document.addEventListener('breakside:power-plan', (e) => {
    if (e.detail?.plan?.gameStateRefresh) startGameStateRefresh();
    else stopGameStateRefresh();
});

/**
 * Update all game screen UI elements after a game state refresh
 */
function updateGameScreenAfterRefresh() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game) return;
    
    // Update score display
    const usScore = game.scores ? game.scores[Role.TEAM] : 0;
    const themScore = game.scores ? game.scores[Role.OPPONENT] : 0;
    updateGameScreenScore(usScore, themScore);
    
    // Update game log panel
    updateGameLogPanel();
    updateGameLogEvents();
    
    // Update Select Line panel (player stats, etc.)
    updateSelectLinePanel();
    updateSelectLineTable();

    // Update Play-by-Play panel state
    updatePlayByPlayPanelState();

    log('🔄 Updated UI after game state refresh');
}

// React to controller-state UI updates via the module-era hook (replaces
// the old window.updateControllerUI wrapper, which broke once
// controllerState.js became a module).
document.addEventListener('breakside:controller-ui-updated', (e) => {
    const { state, previousState } = e.detail;

    // Update game screen role buttons
    if (isGameScreenVisible()) {
        updateGameScreenRoleButtons(state);
        
        // Only update panels for role changes when roles ACTUALLY changed
        // This prevents the Game Log panel from being repeatedly minimized every poll
        const myUserId = window.currentUserId || (typeof getCurrentUserId === 'function' ? getCurrentUserId() : null);
        const wasActiveCoach = previousState?.activeCoach?.userId === myUserId;
        const wasLineCoach = previousState?.lineCoach?.userId === myUserId;
        const isNowActiveCoach = state?.activeCoach?.userId === myUserId;
        const isNowLineCoach = state?.lineCoach?.userId === myUserId;
        
        // Also check if the connected coach count changed (for role panel visibility)
        const coachCountChanged = (previousState?.connectedCoaches?.length || 0) !== (state?.connectedCoaches?.length || 0);

        if (wasActiveCoach !== isNowActiveCoach || wasLineCoach !== isNowLineCoach || coachCountChanged) {
            updatePanelsForRole();
        }
        
        // Update Select Line panel permissions when roles change
        updateSelectLinePanelState();
        
        // Always keep game state refresh running (for viewers to see updates)
        startGameStateRefresh();
    }
});
// --- ES-module exports ---
export {
    enterGameScreen, exitGameScreen,
    updateGameScreenScore, updateGameLogEvents,
    startGameStateRefresh, stopGameStateRefresh,
};
// window survivor: late-bound back-edge hook (called by game/gameLogic.js,
// game/pointManagement.js, screens/navigation.js, teams/rosterManagement.js,
// teams/teamList.js — all evaluate before this file)
window.enterGameScreen = enterGameScreen;
// window survivor: late-bound back-edge hook (called by auth/loginScreen.js,
// game/controllerState.js, game/gameLogic.js — all evaluate before this file)
window.exitGameScreen = exitGameScreen;
// window survivor: late-bound back-edge hook (called by game/gameLogic.js)
window.updateGameScreenScore = updateGameScreenScore;
// window survivor: late-bound back-edge hook (called by ui/eventLogDisplay.js)
window.updateGameLogEvents = updateGameLogEvents;
// window survivor: late-bound back-edge hook (called window-qualified by
// game/controllerState.js, which evaluates before this file)
window.startGameStateRefresh = startGameStateRefresh;
// window survivor: late-bound back-edge hook (called window-qualified by
// game/controllerState.js)
window.stopGameStateRefresh = stopGameStateRefresh;
// Dropped shims (zero external references found): updateGameScreenRoleButtons,
// updateGameLogPanel, updateGameLogStatus. window.escapeHtml dropped with the
// G6 renderer merge: escapeHtml now lives in utils/gameLogRenderer.js, which
// every former window-consumer can import downward.
