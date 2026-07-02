/*
 * Game screen — lifecycle, log/score updates, role buttons & cloud/controller sync.
 * enter/exit game screen, game-log/score panel updates, role-button state, the
 * cloud game-state refresh loop, and the updateControllerUI integration wrapper.
 * Loads LAST (its updateControllerUI wrapper captures controllerState's original).
 * Split from the former monolithic gameScreen.js (refactor, no behavior change).
 */

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
    
    // Also update game log score
    updateGameLogScore(usScore, themScore);
}

// =============================================================================
// Game Log Panel Updates
// =============================================================================

/**
 * Update the Game Log title bar with live score.
 * Format: "TeamName 5 – OppName 2"
 * If the text overflows, collapses to short names:
 *   Our team: currentTeam.teamSymbol (4-char, e.g. "CUDO") — skip if null
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
 * Update the Game Log panel status (teams and score in title bar)
 */
function updateGameLogStatus() {
    updateGameLogTitleScore();
}

/**
 * Update just the score in the Game Log panel title bar
 * @param {number} usScore - Our team's score (unused, reads from game)
 * @param {number} themScore - Opponent's score (unused, reads from game)
 */
function updateGameLogScore(usScore, themScore) {
    updateGameLogTitleScore();
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
    
    // Format the summary for display
    // Split into lines and wrap each in a div for styling
    const lines = summary.split('\n');
    let html = '';
    
    for (const line of lines) {
        if (!line.trim()) continue;
        
        // Add CSS class based on line content
        let lineClass = 'game-log-line';
        
        if (line.includes(' scores!')) {
            lineClass += ' game-log-score-event';
            if (line.includes(getTeamName())) {
                lineClass += ' game-log-us-scores';
            } else {
                lineClass += ' game-log-them-scores';
            }
        } else if (line.startsWith('Point ') && line.includes('roster:')) {
            lineClass += ' game-log-point-header';
        } else if (line.includes('Current score:')) {
            lineClass += ' game-log-current-score';
        } else if (line.includes('pulls to')) {
            lineClass += ' game-log-pull';
        } else if (line.startsWith('— ') && / on (offense|defense) —$/.test(line)) {
            // Possession delimiter line, e.g. "— Breakside on offense —"
            lineClass += ' game-log-possession-header';
            if (line.endsWith('on offense —')) {
                lineClass += ' game-log-possession-offense';
            } else {
                lineClass += ' game-log-possession-defense';
            }
        } else if (line.startsWith('App Version:') || line.startsWith('Game Summary:')) {
            lineClass += ' game-log-header';
        } else if (line.includes('roster:')) {
            lineClass += ' game-log-roster';
        }
        
        html += `<div class="${lineClass}">${escapeHtml(line)}</div>`;
    }
    
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
 * Escape HTML entities to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Full update of the Game Log panel
 * Call this when entering game screen or when game changes significantly
 */
function updateGameLogPanel() {
    updateGameLogStatus();
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
    // Reset stats mode
    panelStatsMode = 'game';
    panelShowingTotalStats = false;
    cachedPanelEventStats = null;

    // Set currentEvent if game is part of an event
    const currentGameObj = typeof currentGame === 'function' ? currentGame() : null;
    if (currentGameObj && currentGameObj.eventId && !currentEvent) {
        // Try to fetch event data (best effort — will be null if not loaded)
        if (typeof listTeamEvents === 'function' && currentGameObj.teamId) {
            listTeamEvents(currentGameObj.teamId).then(events => {
                const ev = events.find(e => e.id === currentGameObj.eventId);
                if (ev) {
                    currentEvent = typeof deserializeTournamentEvent === 'function'
                        ? deserializeTournamentEvent(ev) : ev;
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
    
    // Reset timer pause state when entering
    pointTimerPaused = false;
    
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

    console.log('🎮 Entered game screen');
}

/**
 * Exit the game screen UI
 * Returns to legacy navigation
 */
function exitGameScreen() {
    hideGameScreen();
    stopGameScreenTimerLoop();
    stopGameStateRefresh();

    // Clear event context when leaving game
    currentEvent = null;
    cachedPanelEventStats = null;

    // Reset multi-coach detection for next game
    if (typeof resetMultiCoachDetected === 'function') {
        resetMultiCoachDetected();
    }

    // Resume active-game polling when leaving a game
    if (typeof startActiveGamePolling === 'function') {
        startActiveGamePolling();
    }

    console.log('🎮 Exited game screen');
}

// =============================================================================
// Integration with Controller State
// =============================================================================

// Track game state refresh interval
let gameStateRefreshIntervalId = null;

/**
 * Start periodic refresh of game state from cloud.
 * - Active Coach: Only refresh pending line (they push game data, not pull)
 * - Everyone else: Refresh full game state (scores, points, events)
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
    
    // Refresh every 3 seconds
    gameStateRefreshIntervalId = setInterval(async () => {
        // Stop if no longer visible
        if (!isGameScreenVisible()) {
            stopGameStateRefresh();
            return;
        }
        
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
                if (result && typeof result === 'object' && result.gameJustEnded) {
                    // Game ended by another session/device
                    console.log('🏁 Game ended by another session — leaving game screen');
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
                if (result) {
                    // Game ended by another coach — navigate away
                    if (typeof result === 'object' && result.gameJustEnded) {
                        console.log('🏁 Game ended by another coach — leaving game screen');
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
                    if (!isViewerUser && typeof result === 'object' && (result.scoreChanged || result.pointCountChanged)) {
                        showGameUpdatedToast(result);
                    }
                }
            }
        }
    }, 3000);
    
    console.log('🔄 Started game state refresh polling');
}

/**
 * Stop periodic refresh of game state
 */
function stopGameStateRefresh() {
    if (gameStateRefreshIntervalId) {
        clearInterval(gameStateRefreshIntervalId);
        gameStateRefreshIntervalId = null;
        console.log('⏹️ Stopped game state refresh polling');
    }
}

// Aliases for backwards compatibility
function startPendingLineRefresh() { startGameStateRefresh(); }
function stopPendingLineRefresh() { stopGameStateRefresh(); }

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

    console.log('🔄 Updated UI after game state refresh');
}

// Hook into controller state updates if available
const originalUpdateControllerUI = window.updateControllerUI;
window.updateControllerUI = function(state, previousState) {
    // Call original if it exists
    if (typeof originalUpdateControllerUI === 'function') {
        originalUpdateControllerUI(state, previousState);
    }
    
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
};
window.enterGameScreen = enterGameScreen;
window.exitGameScreen = exitGameScreen;
window.updateGameScreenScore = updateGameScreenScore;
window.updateGameScreenRoleButtons = updateGameScreenRoleButtons;
window.isGameScreenVisible = isGameScreenVisible;

// Game Log panel
window.updateGameLogPanel = updateGameLogPanel;
window.updateGameLogEvents = updateGameLogEvents;
window.updateGameLogStatus = updateGameLogStatus;
