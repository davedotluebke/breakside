/*
 * Game Logic
 * Handles game initialization, scoring, and high-level game state transitions.
 * 
 * Phase 4 update: Games use teamId and create rosterSnapshot
 */
import { Role, Game, createRosterSnapshot, isTestGame } from '../store/models.js';
import { currentTeam, currentEvent, saveAllTeamsData, getActiveRoster } from '../store/storage.js';
import { isScrimmageGame } from '../store/scrimmage.js';
import {
    NO_SCORE, VARIATIONS, TWO_POINT_HINT, variationById, normalizeRules, gameRules,
    conversionRule, scoreOutcome, turnoverOutcome, bankOutcome, isScoringSide,
    pendingValueOf, pointValueOf,
} from '../store/scrimmageRules.js';
import { syncGameToCloud, deleteGameFromCloud } from '../store/sync.js';
import {
    currentGame, getLatestPoint, getActivePossession, getPlayerFromName,
    buildPointPlayerLookup, buildPointMembership,
} from '../utils/helpers.js';
import { applyPointPlayerStats, revertPointPlayerStats } from './pointStats.js';
import { buildGameLogEntries } from '../utils/gameLogRenderer.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { updatePanelsForGameState } from '../ui/panelSystem.js';
import { clearNextLineSelections } from '../ui/activePlayersDisplay.js';
import { showScreen, returnToGameFromRoster } from '../screens/navigation.js';
import { updateTeamRosterDisplay } from '../teams/rosterManagement.js';
import { populateGenderRatioDropdown } from './genderRatioDropdown.js';
import {
    moveToNextPoint, stopCountdown, countdownSeconds,
    setIsPaused, setCountdownSeconds,
} from './pointManagement.js';
import { showControllerToast } from './controllerState.js';
import { applyUndoToGame } from './undoLogic.js';
import {
    rearmPointClockIfUntouched, resumePointClockFromStop, stopReasonOf,
} from '../store/pointClock.js';
import { log } from '../utils/logger.js';

let appVersion = null;

function startNewGame(startingPosition, seconds) {
    const opponentNameInput = document.getElementById('opponentNameInput');
    const opponentName = opponentNameInput.value.trim() || "Bad Guys";

    // Store current totalPointsPlayed into pointsPlayedPreviousGames for each player
    currentTeam.teamRoster.forEach(player => {
        player.pointsPlayedPreviousGames = player.totalPointsPlayed;
    });
    
    // Phase 4: Pass teamId to Game constructor
    const newGame = new Game(currentTeam.name, opponentName, startingPosition, currentTeam.id);

    // Set eventId if starting a game within an event
    if (currentEvent) {
        newGame.eventId = currentEvent.id;
    }

    // Generate ID immediately for the new game
    if (typeof window.generateGameId === 'function') {
        newGame.id = window.generateGameId(newGame);
    }

    // Create roster snapshot — from event roster if in event, else team roster
    if (typeof createRosterSnapshot === 'function') {
        newGame.rosterSnapshot = createRosterSnapshot(currentTeam, currentEvent || undefined);
        log('📸 Created roster snapshot:', newGame.rosterSnapshot);
    }
    
    // Set mixed rules flags from dropdown and checkbox
    const enforceGenderRatioSelect = document.getElementById('enforceGenderRatioSelect');
    const alternateGenderPullsCheckbox = document.getElementById('alternateGenderPullsCheckbox');
    newGame.alternateGenderRatio = enforceGenderRatioSelect ? enforceGenderRatioSelect.value : 'No';
    newGame.alternateGenderPulls = alternateGenderPullsCheckbox ? alternateGenderPullsCheckbox.checked : false;
    
    currentTeam.games.push(newGame);
    
    // Initialize pendingNextLine for panel UI
    newGame.pendingNextLine = {
        activeType: 'od',
        odLine: [],
        oLine: [],
        dLine: [],
        odLineModifiedAt: null,
        oLineModifiedAt: null,
        dLineModifiedAt: null,
        useSeparateLines: false,
        useSeparateLinesAt: null
    };
    
    // Save and Sync Immediately
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }

    logEvent(`New game started against ${opponentName}`);

    // Set countdown seconds before moving to next point
    setCountdownSeconds(seconds);

    // Enter the panel-based game screen
    // late-bound back-edge (gameScreenSync/gameScreenEvents live "above" this
    // layer); see ARCHITECTURE.md § ES modules — the window shim at the owner
    // is kept deliberately.
    if (typeof window.enterGameScreen === 'function') {
        window.enterGameScreen();
    }
    if (typeof window.transitionToBetweenPoints === 'function') {
        window.transitionToBetweenPoints();
    }
    log('🎮 New game started with panel UI');
}

document.getElementById('startGameOnOBtn').addEventListener('click', function() {
    const timerInput = document.getElementById('pointTimerInput');
    const seconds = parseInt(timerInput.value) || 90;
    startNewGame('offense', seconds);
});

document.getElementById('startGameOnDBtn').addEventListener('click', function() {
    const timerInput = document.getElementById('pointTimerInput');
    const seconds = parseInt(timerInput.value) || 90;
    startNewGame('defense', seconds);
});

/**
 * Configure the Start/Continue Game screen for either new-game or mid-game mode.
 * In mid-game mode the inputs are prefilled from the live game, the "Start Game
 * on Offense/Defense" buttons are replaced by an "Apply & Continue" button, and
 * the title reads "Game Settings".
 * @param {boolean} midGame
 */
function configureStartGameMode(midGame) {
    const titleEl = document.getElementById('startGameHeader');
    const startButtons = document.querySelector('#startGameSubscreen .start-game-buttons');
    const applyBtn = document.getElementById('applyGameSettingsBtn');
    const continueBtn = document.getElementById('continueGameBtn');
    const game = (typeof currentGame === 'function') ? currentGame() : null;

    if (midGame && game) {
        if (titleEl) titleEl.textContent = 'Game Settings';

        // Prefill controls from the live game / timer state
        const opp = document.getElementById('opponentNameInput');
        if (opp) opp.value = game.opponent || '';

        const ratioSel = document.getElementById('enforceGenderRatioSelect');
        if (ratioSel) {
            if (typeof populateGenderRatioDropdown === 'function') populateGenderRatioDropdown();
            if (game.alternateGenderRatio) ratioSel.value = game.alternateGenderRatio;
        }

        const pulls = document.getElementById('alternateGenderPullsCheckbox');
        if (pulls) pulls.checked = !!game.alternateGenderPulls;

        const timer = document.getElementById('pointTimerInput');
        if (timer && typeof countdownSeconds !== 'undefined' && countdownSeconds != null) {
            timer.value = countdownSeconds;
        }

        if (startButtons) startButtons.style.display = 'none';
        if (applyBtn) applyBtn.style.display = '';
        if (continueBtn) continueBtn.classList.remove('inactive');
        fillScrimmageRulesSettings(game);
    } else {
        if (titleEl) titleEl.textContent = 'Start Game';
        if (startButtons) startButtons.style.display = '';
        if (applyBtn) applyBtn.style.display = 'none';
        fillScrimmageRulesSettings(null);
    }
}

// ── Scrimmage variation controls on the Game Settings screen ──────────────
// Shown for a squad-game only (store/scrimmageRules.js). Apply writes the
// rules onto THIS half; the other coach sets theirs the same way (the New
// Scrimmage dialog gives both halves the same rules to begin with).

/** Fill (or hide) the #scrimmageRulesSettings block for the game. */
function fillScrimmageRulesSettings(game) {
    const block = document.getElementById('scrimmageRulesSettings');
    if (!block) return;
    const show = !!(game && isScrimmageGame(game));
    block.style.display = show ? '' : 'none';
    if (!show) return;

    const rules = gameRules(game) || { variation: 'standard', twoPointPlays: false, puller: null };
    const variationSel = document.getElementById('gameSettingsVariation');
    if (variationSel) {
        if (!variationSel.options.length) {
            VARIATIONS.forEach(v => variationSel.add(new Option(v.label, v.id)));
        }
        variationSel.value = rules.variation;
        variationSel.onchange = () => renderScrimmageRulesHint(game);
    }
    const twoPoint = document.getElementById('gameSettingsTwoPoint');
    if (twoPoint) twoPoint.checked = rules.twoPointPlays;

    // Squad names from this half's point of view: X and Y keep their keys.
    const pullerSel = document.getElementById('gameSettingsPuller');
    if (pullerSel) {
        const names = game.scrimmageSquad === 'X'
            ? { X: game.team, Y: game.opponent } : { X: game.opponent, Y: game.team };
        pullerSel.innerHTML = '';
        ['X', 'Y'].forEach(s => pullerSel.add(new Option(names[s], s)));
        pullerSel.value = rules.puller || game.scrimmageSquad || 'X';
    }
    renderScrimmageRulesHint(game);
}

function renderScrimmageRulesHint(game) {
    const variationSel = document.getElementById('gameSettingsVariation');
    const def = variationById(variationSel && variationSel.value);
    const hint = document.getElementById('gameSettingsVariationHint');
    if (hint) hint.textContent = `${def.hint} ${TWO_POINT_HINT}`;
    const pullerRow = document.getElementById('gameSettingsPullerRow');
    if (pullerRow) pullerRow.style.display = def.fixedPuller ? '' : 'none';
}

/** Read the block back onto the game (no-op for a real game). */
function readScrimmageRulesSettings(game) {
    if (!game || !isScrimmageGame(game)) return;
    const block = document.getElementById('scrimmageRulesSettings');
    if (!block || block.style.display === 'none') return;
    const variationSel = document.getElementById('gameSettingsVariation');
    const twoPoint = document.getElementById('gameSettingsTwoPoint');
    const pullerSel = document.getElementById('gameSettingsPuller');
    game.scrimmageRules = normalizeRules({
        variation: variationSel ? variationSel.value : 'standard',
        twoPointPlays: !!(twoPoint && twoPoint.checked),
        puller: pullerSel ? pullerSel.value : null,
    });
    document.dispatchEvent(new CustomEvent('breakside:scrimmage-rules-changed'));
}

/**
 * Apply edited settings from the Game Settings screen to the current game so
 * they take effect on the next point. Players-on-field is read live from the
 * DOM during play, so it needs no copy here.
 */
function applyGameSettingsToCurrentGame() {
    const game = (typeof currentGame === 'function') ? currentGame() : null;
    if (!game) return;

    const opp = document.getElementById('opponentNameInput');
    if (opp && opp.value.trim()) game.opponent = opp.value.trim();

    const ratioSel = document.getElementById('enforceGenderRatioSelect');
    if (ratioSel) game.alternateGenderRatio = ratioSel.value;

    const pulls = document.getElementById('alternateGenderPullsCheckbox');
    if (pulls) game.alternateGenderPulls = pulls.checked;

    const timer = document.getElementById('pointTimerInput');
    if (timer) {
        const secs = parseInt(timer.value, 10);
        if (!isNaN(secs)) setCountdownSeconds(secs);
    }

    readScrimmageRulesSettings(game);

    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    if (typeof syncGameToCloud === 'function' && game.id) syncGameToCloud(game);
}

document.getElementById('applyGameSettingsBtn')?.addEventListener('click', function() {
    applyGameSettingsToCurrentGame();
    if (typeof returnToGameFromRoster === 'function') {
        returnToGameFromRoster();
    }
});

/**
 * End the current point: `winner` ('team' | 'opponent', or NO_SCORE for a
 * drill rep nobody scored) takes `value` points (1 ordinarily; 2 for a
 * two-point play or a converted extra point; ignored for NO_SCORE). Every
 * scoring surface reaches this through recordScore below, which applies the
 * scrimmage variation first.
 */
function updateScore(winner, value = 1, { banked = false } = {}) {
    if (winner !== Role.TEAM && winner !== Role.OPPONENT && winner !== NO_SCORE) {
        throw new Error("inactive role");
    }

    const point = getLatestPoint();
    if (!point) {
        throw new Error("No current point");
    }

    // `startTimestamp` doubles as the running-timer segment marker: the score
    // handlers (stopPointTimeAccrual and the Full/Field inline copies) fold the
    // elapsed segment into totalPointTime and null it BEFORE this runs. A null
    // here therefore means "already accounted for" — don't fabricate a start
    // time (the old fallback stamped score time as the point's start, which is
    // why pendingLineLogic can't trust startTimestamp for point-start).
    if (point.startTimestamp !== null) {
        point.totalPointTime += (new Date() - point.startTimestamp);
        point.startTimestamp = null;
    }
    // A clock still armed at the score (nobody touched the pull — a
    // mis-entry, or Simple-mode recording after a Full/Field start) has
    // nothing to bank; the point just ends untimed. A clock still stopped at
    // the score (a timeout with no play recorded after it) has its play
    // time banked already; the stoppage simply ends with the point.
    point.clockPending = false;
    point.clockStopped = null;
    point.endTimestamp = new Date();
    point.winner = winner; // Setting the winning team for the current point
    point.pendingConversion = null;
    point.pendingValue = 0;
    point.banked = !!banked;
    point.pointValue = winner === NO_SCORE ? 0 : Math.max(0, Number(value) || 0);
    if (winner !== NO_SCORE) currentGame().scores[winner] += point.pointValue;

    // Update event log
    if (winner === NO_SCORE) {
        logEvent('Point over — no score');
    } else {
        logEvent(`${point.winner} scores!${point.pointValue !== 1 ? ` (${point.pointValue} points)` : ''}`);
    }

    // Update player stats for those who played this point (including players
    // substituted out mid-point). Membership-based: point.players holds names
    // or ids depending on era. Stamps point.playerStatsCounted so undo can
    // decrement symmetrically (see game/pointStats.js).
    applyPointPlayerStats(point, currentTeam.teamRoster, buildPointMembership(currentGame()));

    // Phase 6b: Update game screen score display
    // late-bound back-edge (gameScreenSync lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.updateGameScreenScore === 'function') {
        const game = currentGame();
        window.updateGameScreenScore(game.scores[Role.TEAM], game.scores[Role.OPPONENT]);
    }

    summarizeGame();
    saveAllTeamsData(); // Save and Sync
}

// ── Scrimmage variations: the scoring entry points ────────────────────────
// The decisions are pure (store/scrimmageRules.js); this is where they land
// on the live point. Without rules on the game these reduce to the plain
// updateScore + moveToNextPoint every surface used to call directly.

/** "Dark" / "Light" in a scrimmage; the team and opponent names otherwise. */
function sideName(game, side) {
    return side === Role.TEAM ? (game.team || 'We') : (game.opponent || 'They');
}

function announceRulesState(detail = {}) {
    // The Simple panel's Bank / Missed / No Score controls follow the point
    // state, and a Bank score opens the bank-or-press chooser
    // (game/scrimmageVariations.js listens). A CustomEvent rather than an
    // import: the UI layer sits above this one.
    document.dispatchEvent(new CustomEvent('breakside:scrimmage-rules-changed', { detail }));
}

/**
 * Record a score by `scorer` ('team' | 'opponent') under the game's rules:
 * ends the point and advances (the ordinary case), or — under a conversion
 * rule — leaves the point live with the conversion pending. The two-point
 * box counts on the score that ends the point.
 * @returns {object} the scoreOutcome decision that was applied
 */
function recordScore(scorer, { twoPoint = false } = {}) {
    const game = currentGame();
    const point = getLatestPoint();
    const outcome = scoreOutcome(game, point, scorer, { twoPoint });
    if (outcome.action === 'pending') {
        const rule = conversionRule(game);
        if (outcome.voided) {
            logEvent(rule === 'bank'
                ? `${sideName(game, outcome.voided)}'s unbanked run forfeited`
                : `${sideName(game, outcome.voided)} missed the conversion — score voided`);
        }
        point.pendingConversion = outcome.by;
        point.pendingValue = outcome.value || 1;
        // The score handlers fold the running segment and null startTimestamp
        // before calling here (they assume the point ends); it plays on, so
        // the clock runs again — unless a stoppage holds it.
        if (point.startTimestamp === null && !point.clockStopped && !point.clockPending) {
            point.startTimestamp = new Date();
        }
        const who = sideName(game, outcome.by);
        const text = rule === 'bank'
            ? `${who} scored — ${point.pendingValue} unbanked: bank or press on?`
            : rule === 'double'
                ? `${who} scored — bring it out and score again to make it count`
                : `${who} scored — bring it out for the extra point`;
        logEvent(text);
        showControllerToast(text, 'info');
        saveAllTeamsData();
        announceRulesState({ reason: 'score', by: outcome.by });
        return outcome;
    }
    if (outcome.missed && outcome.dropped) {
        // Extra point: the other side scored while a conversion was pending.
        const text = `${sideName(game, outcome.winner)}'s extra point missed — one point. `
            + `${sideName(game, outcome.dropped)}'s score was not recorded: start the next point and record it there.`;
        logEvent(text);
        showControllerToast(text, 'warning');
    } else if (outcome.converted) {
        logEvent(`${sideName(game, outcome.winner)} converted`);
    }
    updateScore(outcome.winner, outcome.value);
    moveToNextPoint();
    return outcome;
}

/**
 * The disc changed hands (any turnover, either side) — or the coach tapped
 * Missed: a pending conversion is over, and under a possession limit the rep
 * may be too. Called by the possession core after every turnover event, and
 * by the Simple panel's manual control. No-op without rules.
 * @returns {object} the turnoverOutcome decision that was applied
 */
function settlePointAfterTurnover() {
    const game = currentGame();
    const point = getLatestPoint();
    if (!game || !point || point.winner) return { action: 'none' };
    const outcome = turnoverOutcome(game, point);
    if (outcome.action === 'clearPending') {
        point.pendingConversion = null;
        point.pendingValue = 0;
        const text = outcome.forfeited !== undefined
            ? `${sideName(game, outcome.missedBy)} turned it over — ${outcome.forfeited} unbanked point${outcome.forfeited === 1 ? '' : 's'} forfeited, play on`
            : `${sideName(game, outcome.missedBy)} missed the conversion — score voided, play on`;
        logEvent(text);
        showControllerToast(text, 'info');
        saveAllTeamsData();
        announceRulesState();
    } else if (outcome.action === 'end') {
        logEvent(outcome.dead
            ? 'Possessions used up — point over'
            : `${sideName(game, outcome.winner)} missed the extra point — one point`);
        updateScore(outcome.winner, outcome.value);
        moveToNextPoint();
    }
    return outcome;
}

/** Bank the unbanked run (Bank): the point ends for the side with the run, which the other squad then takes the disc from. */
function bankPendingPoints() {
    const game = currentGame();
    const point = getLatestPoint();
    if (!game || !point || point.winner) return { action: 'none' };
    const outcome = bankOutcome(game, point);
    if (outcome.action !== 'end') return outcome;
    logEvent(`${sideName(game, outcome.winner)} banks ${outcome.value}`);
    updateScore(outcome.winner, outcome.value, { banked: true });
    moveToNextPoint();
    return outcome;
}

/** The coach's call that the rep is over with nobody scoring (Simple mode has no turnover events). */
function endPointWithoutScore() {
    const point = getLatestPoint();
    if (!point || point.winner) return;
    updateScore(NO_SCORE, 0);
    moveToNextPoint();
}

// Legacy end game, switch sides, timeout, halftime buttons removed —
// panel UI (gameScreen.js) handles all game events.


// Review-screen footer (index.html #gameSummaryScreen footer): New Game.
document.getElementById('anotherGameBtn').addEventListener('click', function() {
    stopCountdown();
    setIsPaused(false);
    clearNextLineSelections();

    // Phase 6b: Exit game screen if visible
    // late-bound back-edge (gameScreenSync lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.exitGameScreen === 'function') {
        window.exitGameScreen();
    }
    
    updateTeamRosterDisplay();
    document.getElementById('continueGameBtn').classList.add('inactive');
    showScreen('teamRosterScreen');
});

async function loadVersion() {
    try {
        const response = await fetch('./version.json');
        const versionData = await response.json();
        appVersion = versionData;
        return versionData;
    } catch (error) {
        console.warn('Could not load version information:', error);
        appVersion = { version: 'unknown', build: 'unknown' };
        return appVersion;
    }
}

loadVersion();

function downloadJSON(jsonData, filename) {
    // Create a Blob with the JSON data
    const blob = new Blob([jsonData], {type: 'application/json'});
    // Create a URL for the blob
    const url = URL.createObjectURL(blob);
    // Create a temporary anchor element and set its href to the blob URL
    const a = document.createElement('a');
    a.href = url;
    // Set the download attribute to suggest a filename for the download based on current teams and date
    a.download = filename || `${currentGame().team}_${currentGame().opponent}_${new Date().toISOString()}.json`;
    // Append the anchor to the body, click it, and then remove it
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke the blob URL to free up resources
    URL.revokeObjectURL(url);
}

/**
 * Build the full game-log text for the current game (Copy Game Log clipboard;
 * also feeds the in-game Log tab via gameScreenSync.updateGameLogEvents).
 * The line format itself lives in utils/gameLogRenderer.js — shared with the
 * post-game summary renderer (G6 merge); make format changes there.
 */
/**
 * The current game's log as structured entries (utils/gameLogRenderer.js
 * buildGameLogEntries) with the in-game header options — the Log tab renders
 * these so each line carries its entry index; the replay viewer scrubs them.
 */
function summarizeGameEntries() {
    return buildGameLogEntries(currentGame(), gameLogEntryOptions());
}

/**
 * The buildGameLogEntries options the in-game log is rendered with. Shared
 * with the replay view (playByPlay/replayView.js), whose engine must build
 * the SAME entry list so its indices match the log's data-entry attributes.
 */
function gameLogEntryOptions() {
    let versionInfo = '';
    if (appVersion) {
        versionInfo = `App Version: ${appVersion.version} (Build ${appVersion.build})\n`;
    }
    const game = currentGame();
    // "Point N roster:" entries may be player ids (id-era games) — resolve to
    // display names; event lines already carry resolved {name, id} refs.
    const lookup = buildPointPlayerLookup(game);
    // The "<team> roster:" line names who this game can field: the squad in
    // a scrimmage (store/scrimmage.js), the team roster otherwise.
    const roster = isScrimmageGame(game) ? getActiveRoster() : currentTeam.teamRoster;
    return {
        teamName: game.team,
        opponentName: game.opponent,
        versionInfo,
        rosterNames: roster.map(player => player.name),
        resolvePlayerName: entry => lookup(entry).name,
    };
}

/** The current game's log as clipboard text (joined summarizeGameEntries). */
function summarizeGame() {
    const summary = summarizeGameEntries().map(e => e.text).join('\n');
    log(summary);
    return summary;
}

// logEvent is now in ui/eventLogDisplay.js

let undoPastStartTimestamp = null;
// Separate double-tap window for backing out a freshly-started point (zero
// possessions). Can't share undoPastStartTimestamp: that one is reset at the
// top of every undoEvent() call that finds points to undo.
let undoEmptyPointTimestamp = null;

/**
 * Revert the score and player stats set by updateScore() for a point.
 * Used by undoEvent() when reverting a scored point.
 */
function revertPointScore(point) {
    const game = currentGame();
    if (isScoringSide(point.winner)) game.scores[point.winner] -= pointValueOf(point);

    // Decrement the per-player counters updateScore applied. Era-paired: the
    // point's playerStatsCounted marker picks membership vs legacy raw-name
    // matching so undo never decrements counters that were never incremented
    // (see game/pointStats.js).
    revertPointPlayerStats(point, currentTeam.teamRoster, buildPointMembership(game));

    // Under a conversion rule every scored point went through "conversion
    // pending" first, so that is the state the point returns to; a banked
    // run comes back whole, unbanked.
    const rule = conversionRule(game);
    point.pendingConversion = (rule && isScoringSide(point.winner)) ? point.winner : null;
    point.pendingValue = point.pendingConversion ? (point.banked ? pointValueOf(point) : 1) : 0;
    point.banked = false;
    point.winner = "";
    point.pointValue = 1;
    point.endTimestamp = null;
    announceRulesState();
    point.startTimestamp = new Date();

    // late-bound back-edge (gameScreenSync lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.updateGameScreenScore === 'function') {
        const game = currentGame();
        window.updateGameScreenScore(game.scores[Role.TEAM], game.scores[Role.OPPONENT]);
    }

    // Stop between-points countdown and restore in-point panel layout
    stopCountdown();
    if (typeof updatePanelsForGameState === 'function') {
        updatePanelsForGameState(true);
    }
}

/**
 * Undo the most recent event
 */
function undoEvent() {
    // Guard: no points in the game — warn, then offer to delete game on double-tap
    if (currentGame().points.length === 0) {
        const now = Date.now();
        if (undoPastStartTimestamp && (now - undoPastStartTimestamp) < 4000) {
            // Second press — offer restart
            undoPastStartTimestamp = null;
            // Skip the confirm for test games (throwaway dev data).
            const skipDeleteConfirm = typeof isTestGame === 'function' && isTestGame(currentGame());
            if (skipDeleteConfirm || confirm('This will delete the current game and return to the new game screen. Are you sure?')) {
                const gameId = currentGame().id;
                currentTeam.games.pop();
                // Delete from cloud
                if (typeof deleteGameFromCloud === 'function') {
                    deleteGameFromCloud(gameId);
                }
                stopCountdown();
                setIsPaused(false);
                clearNextLineSelections();
                // late-bound back-edge (gameScreenSync lives "above" this layer);
                // see ARCHITECTURE.md § ES modules — owner keeps the shim.
                if (typeof window.exitGameScreen === 'function') {
                    window.exitGameScreen();
                }
                updateTeamRosterDisplay();
                document.getElementById('continueGameBtn').classList.add('inactive');
                showScreen('teamRosterScreen');
                saveAllTeamsData();
            }
        } else {
            // First press — show toast, set timestamp
            undoPastStartTimestamp = now;
            if (typeof showControllerToast === 'function') {
                showControllerToast('No events to undo', 'warning');
            }
        }
        return;
    }
    undoPastStartTimestamp = null; // Reset if there are events to undo

    // The decision tree lives in undoLogic.js (pure, unit-tested); this
    // function handles the UI/persistence side effects it prescribes.
    const result = applyUndoToGame(currentGame(), {
        getActivePossession,
        resolvePlayer: getPlayerFromName,
        revertPointScore,
    });
    // A pending conversion may have been taken back (scrimmage variations).
    announceRulesState();

    // Undoing the first touch of an offensive point puts the clock back to
    // waiting for it (store/pointClock.js): the time since the mistaken tap
    // is dropped. No-op unless the surviving point has no touch left, on a
    // surface that defers the clock.
    if (result.outcome !== 'none' && !result.pointRemoved) {
        const mode = (typeof window.getCurrentMode === 'function') ? window.getCurrentMode() : 'simple';
        if (rearmPointClockIfUntouched(getLatestPoint(), mode)) {
            log('⏱ Point clock re-armed — first touch undone');
        }
        // Undoing the timeout or injury sub that stopped the clock: it runs
        // again from the moment it stopped, as if the stoppage had never
        // been recorded, so a mis-tap costs no time. Undoing a play leaves a
        // running clock running.
        if (resumePointClockFromStop(getLatestPoint(), stopReasonOf(result.undoneEvent))) {
            log('⏱ Point clock resumed from the stop — stoppage undone');
            logEvent('Point clock restarted');
        }
    }

    if (result.outcome === 'score-reverted') {
        if (result.pointRemoved) moveToNextPoint();
        logEvent("Undo: score reverted");
        saveAllTeamsData();
        return;
    }

    if (result.outcome === 'none') {
        // Point started (Start Point tapped) but nothing recorded yet —
        // possessions is empty, so the decision tree has nothing to pop.
        // Back out the point start itself, double-tap guarded (like the
        // delete-game path) so a stray Undo can't quietly kill the point.
        // point.winner is never set here: winner-without-score-event
        // resolves to 'score-reverted' above, and a winner WITH a score
        // event implies a possession exists.
        const now = Date.now();
        if (undoEmptyPointTimestamp && (now - undoEmptyPointTimestamp) < 4000) {
            undoEmptyPointTimestamp = null;
            currentGame().points.pop();
            logEvent('Undo: point start reverted');
            // Back to the between-points state (panels, countdown, line select)
            moveToNextPoint();
            if (typeof showControllerToast === 'function') {
                showControllerToast('Point start undone', 'info');
            }
            saveAllTeamsData();
        } else {
            undoEmptyPointTimestamp = now;
            if (typeof showControllerToast === 'function') {
                showControllerToast('Nothing recorded yet — tap Undo again to back out of this point', 'warning');
            }
        }
        return;
    }
    if (result.outcome === 'event-undone') {
        logEvent(`Undid event: ${result.undoneEvent.summarize()}`);
    }
    if (result.pointRemoved) {
        // display the "before point screen"
        moveToNextPoint();
    }
    // logEvent refreshes the on-screen log from summarizeGame(); the
    // possession-pop branch doesn't log anything itself, so this final
    // call is what keeps the display in sync on that path.
    logEvent("Undo applied");
    saveAllTeamsData(); // Save and Sync
}

// Set up undo button event listener
document.addEventListener('DOMContentLoaded', function() {
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
        undoBtn.addEventListener('click', undoEvent);
    }
});

// --- ES-module exports ---
export {
    updateScore, recordScore, settlePointAfterTurnover, bankPendingPoints, endPointWithoutScore,
    summarizeGame, summarizeGameEntries, gameLogEntryOptions, downloadJSON, undoEvent,
    configureStartGameMode, appVersion,
};
// window survivor: late-bound back-edge hook (called by ui/eventLogDisplay.js,
// which evaluates before this file — importing from here would add a
// gameLogic↔eventLogDisplay cycle)
window.summarizeGame = summarizeGame;
// window survivor: late-bound back-edge hook (called by screens/navigation.js,
// which evaluates before this file — importing from here would create a
// gameLogic↔navigation cycle)
window.configureStartGameMode = configureStartGameMode;
