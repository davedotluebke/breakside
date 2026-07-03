/*
 * Score Attribution Dialog
 * Handles the "We Score" player attribution dialog (thrower/receiver selection).
 * Extracted from simpleModeScreen.js during legacy screen cleanup.
 */
import { Throw, Possession, Role, UNKNOWN_PLAYER } from '../store/models.js';
import { saveAllTeamsData } from '../store/storage.js';
import { getLatestPoint, getPlayerFromName } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { updateScore } from '../game/gameLogic.js';
import { moveToNextPoint } from '../game/pointManagement.js';
import { showControllerToast } from '../game/controllerState.js';
import { ensurePossessionExists } from './keyPlayDialog.js';

// Track selected players for score attribution
let selectedThrower = null;
let selectedReceiver = null;

// Field-tab location pass-through. The Field PBP screen records where the
// disc was thrown from / caught (normalized {x,y} field coords — see
// fieldPbp.js). When the dialog is opened from there, these carry the tap
// locations into the committed Throw so the spatial marker survives. null for
// Simple/Full (which have no field geometry). Set every
// showScoreAttributionDialog() call.
let pendingFrom = null;
let pendingTo = null;

// When true, having both thrower and receiver selected does NOT auto-
// create the score event. Set to true when the dialog is opened with
// pre-selections from Full PBP (or anywhere else that has thrower/
// receiver context up front), so the user has time to tap modifier
// flags before committing. The Score button is the explicit commit in
// that case. Cleared on every showScoreAttributionDialog() call.
let suppressAutoFire = false;

// The throw-modifier flags (Huck/Break/Sky/Layout/Hammer) are toggle buttons,
// not checkboxes — tighter and tidier. Selected state lives in the .selected
// class + aria-pressed rather than an input's .checked. These helpers keep the
// rest of the file agnostic to that.
const FLAG_IDS = ['huckFlag', 'breakFlag', 'skyFlag', 'layoutFlag', 'hammerFlag'];
function setFlag(id, on) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('selected', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
function getFlag(id) {
    const btn = document.getElementById(id);
    return !!(btn && btn.classList.contains('selected'));
}

/**
 * Gate event-recording on the global Active-Coach role (or solo / no-roles
 * fallback handled by canEditPlayByPlay). Surfaces a toast and returns false so
 * the caller can early-out. Mirrors requireActiveCoach() in fullPbp/fieldPbp —
 * the score dialog's Score/Callahan commits are real event-recording paths and
 * must obey the same role gate. Defaults to allowed if the helper isn't loaded.
 */
function requireActiveCoach() {
    const ok = (typeof window.canEditPlayByPlay === 'function')
        ? window.canEditPlayByPlay() : true;
    if (!ok && typeof showControllerToast === 'function') {
        showControllerToast('Only the Active Coach can record events', 'warning', 2200);
    }
    return ok;
}

/**
 * Initialize score attribution dialog event handlers
 * Should be called after DOM is ready
 */
function initializeScoreAttributionDialog() {
    const callahanBtn = document.getElementById('callahanBtn');
    const scoreConfirmBtn = document.getElementById('scoreConfirmBtn');
    const continuePossessionBtn = document.getElementById('continuePossessionBtn');
    const scoreAttributionDialogClose = document.querySelector('#scoreAttributionDialog .close');

    // Modifier toggle buttons: click flips selected state.
    FLAG_IDS.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => setFlag(id, !getFlag(id)));
    });

    // Explicit "Score" commit button. Same code path as the auto-fire
    // branch in handleScoreAttribution. Enabled only when both thrower
    // and receiver are selected.
    if (scoreConfirmBtn) {
        scoreConfirmBtn.addEventListener('click', () => {
            if (!selectedThrower || !selectedReceiver) return;
            commitScoreAttribution();
        });
    }

    if (continuePossessionBtn) {
        continuePossessionBtn.addEventListener('click', () => {
            // Two roles for one button. When a full thrower→receiver pair is
            // present (Field / Full PBP), record the pass as a plain completion
            // and keep the disc live. With no such pair (Simple mode, where
            // selecting both auto-fires the score before this is reachable),
            // it's just a "never mind, not a score" — close the dialog, same as
            // the X. No event recorded either way unless a completion is.
            if (selectedThrower && selectedReceiver) {
                continuePossessionAttribution();
            } else {
                const dialog = document.getElementById('scoreAttributionDialog');
                if (dialog) dialog.style.display = 'none';
            }
        });
    }

    if (callahanBtn) {
        callahanBtn.addEventListener('click', function() {
            if (!requireActiveCoach()) return;
            const dialog = document.getElementById('scoreAttributionDialog');
            // Use whichever player is selected (receiver or thrower) as the
            // defender who caught the Callahan. Route through the shared
            // possession core so the event is logged, persisted, AND published
            // on the narration bus (Full/Field tabs repaint); createDefense
            // also awards the defender's goal, updates the score, and advances
            // the point on a Callahan.
            const defender = selectedReceiver || selectedThrower || null;
            const callahanEvent = window.pbpPossession.createDefense(defender, {
                Callahan: true,
                from: pendingFrom,
                to: pendingTo
            });
            if (!defender) console.log('Warning: no defender selected for Callahan');
            if (dialog) dialog.style.display = 'none';
            if (!callahanEvent) {
                // No defender → createDefense no-ops. Preserve the legacy
                // behavior of still scoring + advancing on an unattributed
                // Callahan (the button is normally only enabled with one
                // player selected, so this is a rare fallback).
                if (typeof updateScore === 'function') updateScore(Role.TEAM);
                if (typeof moveToNextPoint === 'function') moveToNextPoint();
            }
        });
    }

    // (No "Skip" button — to score with unattributed players, pick the
    // Unknown Player in both columns, which produces the same unknown→unknown
    // scoring throw.)

    // Close dialog when clicking the X
    if (scoreAttributionDialogClose) {
        scoreAttributionDialogClose.addEventListener('click', function() {
            document.getElementById('scoreAttributionDialog').style.display = 'none';
        });
    }

    // Close dialog when clicking outside
    window.addEventListener('click', function(event) {
        const dialog = document.getElementById('scoreAttributionDialog');
        if (event.target === dialog) {
            dialog.style.display = 'none';
        }
    });

    // Re-fit the player rows when the viewport changes while the dialog is
    // open (window resize, device rotation). Coalesced to the next task.
    let fitPending = 0;
    window.addEventListener('resize', () => {
        if (fitPending) return;
        fitPending = setTimeout(() => { fitPending = 0; fitScoreButtons(); }, 0);
    });
}

/**
 * Open the Score Attribution dialog, optionally with thrower / receiver
 * pre-selected and modifier flags pre-checked.
 *
 * @param {object} [opts]
 * @param {Player|null} [opts.thrower]    Pre-select this player as thrower.
 * @param {Player|null} [opts.receiver]   Pre-select this player as receiver.
 * @param {boolean}    [opts.breakArmed] Pre-check the Break modifier.
 * @param {object|null} [opts.from]       Field-tab throw-from location {x,y}.
 * @param {object|null} [opts.to]         Field-tab catch location {x,y}.
 *
 * When either thrower or receiver is pre-selected, the auto-fire behavior
 * (which normally commits when both selections are made via clicks) is
 * suppressed for the lifetime of the dialog. The user must explicitly
 * tap the Score button (or Skip / Callahan / X) — giving them time to
 * toggle modifier flags first. Without this suppression, opening with
 * both pre-selected would fire immediately and the user could never
 * specify modifiers.
 */
function showScoreAttributionDialog(opts) {
    opts = opts || {};
    const dialog = document.getElementById('scoreAttributionDialog');
    const throwerButtons = document.getElementById('throwerButtons');
    const receiverButtons = document.getElementById('receiverButtons');

    // Reset selections
    selectedThrower = null;
    selectedReceiver = null;
    suppressAutoFire = !!(opts.thrower || opts.receiver);
    pendingFrom = opts.from || null;
    pendingTo = opts.to || null;

    // Reset modifier toggles
    setFlag('huckFlag', false);
    setFlag('breakFlag', !!opts.breakArmed);
    setFlag('skyFlag', false);
    setFlag('layoutFlag', false);
    setFlag('hammerFlag', false);

    // Clear existing buttons
    throwerButtons.innerHTML = '';
    receiverButtons.innerHTML = '';

    // Add Unknown Player buttons
    const unknownThrowerBtn = createPlayerButton(UNKNOWN_PLAYER);
    const unknownReceiverBtn = createPlayerButton(UNKNOWN_PLAYER);
    throwerButtons.appendChild(unknownThrowerBtn);
    receiverButtons.appendChild(unknownReceiverBtn);

    // Add player buttons
    const point = getLatestPoint();
    point.players.forEach(playerName => {
        const throwerBtn = createPlayerButton(playerName);
        const receiverBtn = createPlayerButton(playerName);
        throwerButtons.appendChild(throwerBtn);
        receiverButtons.appendChild(receiverBtn);
    });

    // Pre-select if caller supplied players. Done by setting module state
    // + marking buttons selected + disabling the cross-column twin (same
    // bookkeeping handleScoreAttribution does on a real click). We don't
    // route through handleScoreAttribution itself because its auto-fire
    // branch would short-circuit the suppression we just set up.
    if (opts.thrower) {
        const throwerName = opts.thrower.name;
        selectedThrower = opts.thrower;
        document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
            if (btn.dataset.playerName === throwerName) btn.classList.add('selected');
        });
        if (throwerName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === throwerName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    }
    if (opts.receiver) {
        const receiverName = opts.receiver.name;
        selectedReceiver = opts.receiver;
        document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
            if (btn.dataset.playerName === receiverName) btn.classList.add('selected');
        });
        if (receiverName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === receiverName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    }

    // Callahan only ever applies in Simple mode — it's a defensive score, so
    // it can never happen on an offensive possession (Field / Full PBP). In
    // those contexts we keep the button present-but-disabled as a reminder
    // that the option exists, but mark the dialog so the wide/landscape layout
    // can collapse it away to reclaim room. See main.css (orientation:landscape).
    const callahanApplicable = opts.callahanApplicable === true;
    dialog.classList.toggle('callahan-inapplicable', !callahanApplicable);

    // Initialize Callahan + Score button states.
    updateCallahanButtonState();
    updateScoreButtonState();

    // Show dialog
    dialog.style.display = 'block';

    // Fit the player rows for the current orientation (no-op in portrait).
    fitScoreButtons();
}

/**
 * Wide/landscape fit for the two player rows: never wrap onto a second line —
 * progressively collapse, then horizontally scroll as a last resort. Mirrors
 * fitPlayers() in fieldPbp.js. The collapse stages (cumulative classes on the
 * .score-attribution-container) are:
 *   1. sa-shrink-unknown — Unknown button "Unknown Player" → "Unknown"
 *   2. sa-min-unknown    — Unknown button → "?"
 *   3. sa-tight          — reduce every button's padding/font
 * After all stages, the rows (flex-nowrap + overflow-x:auto) scroll. Both
 * rows share the same level so they stay visually aligned. No-op in portrait.
 */
function fitScoreButtons() {
    const dialog = document.getElementById('scoreAttributionDialog');
    if (!dialog || dialog.style.display === 'none') return;
    const container = dialog.querySelector('.score-attribution-container');
    if (!container) return;

    const STAGES = ['sa-shrink-unknown', 'sa-min-unknown', 'sa-tight'];
    container.classList.remove(...STAGES);

    // Only the wide (landscape) layout uses single-row scrolling player lists.
    if (!window.matchMedia('(orientation: landscape)').matches) return;

    const rows = Array.from(container.querySelectorAll('.player-buttons'));
    if (!rows.length) return;
    const fits = () => rows.every(r => r.scrollWidth <= r.clientWidth + 1);

    for (let i = 0; i < STAGES.length; i++) {
        if (fits()) return;
        container.classList.add(STAGES[i]);
    }
    // Still overflowing after all stages → the rows scroll horizontally.
}

function createPlayerButton(playerName) {
    const button = document.createElement('button');
    button.classList.add('player-button');
    // Store the canonical name for matching — the visible label may differ
    // (the Unknown button collapses responsively in the wide layout).
    button.dataset.playerName = playerName;
    if (playerName === UNKNOWN_PLAYER) {
        button.classList.add('unknown-player');
        // Three collapse levels for the wide/landscape fit (fitScoreButtons):
        // full → "Unknown" → "?". CSS shows exactly one; default is full.
        button.innerHTML =
            '<span class="upl-full">' + UNKNOWN_PLAYER + '</span>' +
            '<span class="upl-mid">Unknown</span>' +
            '<span class="upl-min">?</span>';
    } else {
        button.textContent = playerName;
    }
    button.addEventListener('click', function() {
        handleScoreAttribution(playerName, this.parentElement.id === 'throwerButtons', this);
    });
    return button;
}

function updateCallahanButtonState() {
    const callahanBtn = document.getElementById('callahanBtn');
    if (callahanBtn) {
        if (selectedReceiver && !selectedThrower) {
            callahanBtn.disabled = false;
            callahanBtn.classList.remove('inactive');
        } else if (selectedThrower && !selectedReceiver) {
            callahanBtn.disabled = false;
            callahanBtn.classList.remove('inactive');
        } else {
            callahanBtn.disabled = true;
            callahanBtn.classList.add('inactive');
        }
    }
}

function updateScoreButtonState() {
    // Only the Score commit needs a full thrower→receiver pair. The
    // "continue possession" button stays enabled in every state: with a pair
    // it records a completion, without one it just dismisses the dialog.
    const scoreBtn = document.getElementById('scoreConfirmBtn');
    if (!scoreBtn) return;
    const ready = !!(selectedThrower && selectedReceiver);
    scoreBtn.disabled = !ready;
    scoreBtn.classList.toggle('inactive', !ready);
}

/**
 * Commit the current selections + flags as a scoring Throw event, then
 * close the dialog and move to the next point. Shared by both the
 * auto-fire-on-both-clicked path (Simple mode) and the explicit Score
 * button (Full PBP / pre-selected path).
 */
function commitScoreAttribution() {
    if (!selectedThrower || !selectedReceiver) return;
    // Recording a goal is gated on the Active-Coach role, same as every other
    // event-entry surface (Field/Full re-check before committing). Without this
    // a line coach reaching the dialog could commit a score.
    if (!requireActiveCoach()) return;
    const dialog = document.getElementById('scoreAttributionDialog');

    const opts = {
        score: true,
        huck: getFlag('huckFlag'),
        breakmark: getFlag('breakFlag'),
        sky: getFlag('skyFlag'),
        layout: getFlag('layoutFlag'),
        hammer: getFlag('hammerFlag'),
        from: pendingFrom,
        to: pendingTo
    };

    // Route through the shared possession core so the scoring throw is recorded
    // identically to every other PBP surface: completedPasses + assist (thrower)
    // + goal (receiver) stats, logged, persisted, AND published on the narration
    // bus (so Full/Field repaint), plus updateScore + moveToNextPoint on score.
    // (The old path built a raw Throw and never published to the bus.)
    if (window.pbpPossession && typeof window.pbpPossession.createThrow === 'function') {
        window.pbpPossession.createThrow(selectedThrower, selectedReceiver, opts);
        if (dialog) dialog.style.display = 'none';
        return;
    }

    // Fallback if the shared core isn't loaded: build the scoring throw
    // directly (mirrors createThrow's stat bookkeeping) and advance the point.
    const scoreEvent = new Throw({
        thrower: selectedThrower,
        receiver: selectedReceiver,
        score: true,
        huck: opts.huck, breakmark: opts.breakmark, sky: opts.sky,
        layout: opts.layout, hammer: opts.hammer,
        from: opts.from, to: opts.to
    });
    const possession = (typeof ensurePossessionExists === 'function')
        ? ensurePossessionExists(true)
        : (() => {
            const point = getLatestPoint();
            const p = new Possession(true);
            point.addPossession(p);
            return p;
        })();
    possession.addEvent(scoreEvent);
    if (typeof selectedThrower.completedPasses !== 'number') {
        selectedThrower.completedPasses = 0;
    }
    selectedThrower.completedPasses += 1;
    selectedThrower.assists = (selectedThrower.assists || 0) + 1;
    selectedReceiver.goals = (selectedReceiver.goals || 0) + 1;
    if (typeof logEvent === 'function') logEvent(scoreEvent.summarize());
    if (window.narrationEventBus) window.narrationEventBus.publish('eventAdded', { event: scoreEvent });
    updateScore(Role.TEAM);
    if (dialog) dialog.style.display = 'none';
    moveToNextPoint();
}

/**
 * "Actually not a score — continue possession." Records the same thrower→
 * receiver pass as a plain completion (score:false) with the field location,
 * keeps the disc live (receiver becomes the new holder), and does NOT advance
 * the point. For when the coach opened the score dialog but the catch turned
 * out not to be in the endzone. Routes through pbpPossession.createThrow so
 * the event is logged, published on the bus (every PBP tab repaints), and
 * persisted — same as any other in-point throw.
 */
function continuePossessionAttribution() {
    if (!selectedThrower || !selectedReceiver) return;
    const dialog = document.getElementById('scoreAttributionDialog');

    const opts = {
        score: false,
        huck: getFlag('huckFlag'),
        breakmark: getFlag('breakFlag'),
        sky: getFlag('skyFlag'),
        layout: getFlag('layoutFlag'),
        hammer: getFlag('hammerFlag'),
        from: pendingFrom,
        to: pendingTo
    };

    if (window.pbpPossession && typeof window.pbpPossession.createThrow === 'function') {
        window.pbpPossession.createThrow(selectedThrower, selectedReceiver, opts);
    } else {
        // Fallback: build the completion directly and publish so subscribed
        // tabs still repaint. Mirrors the createThrow stat bookkeeping minus
        // the score branch.
        const evt = new Throw({
            thrower: selectedThrower,
            receiver: selectedReceiver,
            score: false,
            huck: opts.huck, breakmark: opts.breakmark, sky: opts.sky,
            layout: opts.layout, hammer: opts.hammer,
            from: opts.from, to: opts.to
        });
        const possession = (typeof ensurePossessionExists === 'function')
            ? ensurePossessionExists(true)
            : (() => { const p = new Possession(true); getLatestPoint().addPossession(p); return p; })();
        possession.addEvent(evt);
        if (typeof selectedThrower.completedPasses !== 'number') selectedThrower.completedPasses = 0;
        selectedThrower.completedPasses += 1;
        if (typeof logEvent === 'function') logEvent(evt.summarize());
        if (window.narrationEventBus) window.narrationEventBus.publish('eventAdded', { event: evt });
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    }

    if (dialog) dialog.style.display = 'none';
}

function handleScoreAttribution(playerName, isThrower, buttonElement) {
    const player = getPlayerFromName(playerName);

    // Check if this button is already selected
    if (buttonElement.classList.contains('selected')) {
        buttonElement.classList.remove('selected');
        if (isThrower) {
            selectedThrower = null;
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === playerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        } else {
            selectedReceiver = null;
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === playerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        }
        updateCallahanButtonState();
        updateScoreButtonState();
        return;
    }

    if (isThrower) {
        if (selectedThrower) {
            const previousThrowerName = selectedThrower.name;
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === previousThrowerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        }
        selectedThrower = player;
        document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
            btn.classList.remove('selected');
        });
        buttonElement.classList.add('selected');
        if (playerName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === playerName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    } else {
        if (selectedReceiver) {
            const previousReceiverName = selectedReceiver.name;
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === previousReceiverName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        }
        selectedReceiver = player;
        document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
            btn.classList.remove('selected');
        });
        buttonElement.classList.add('selected');
        if (playerName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.dataset.playerName === playerName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    }

    updateCallahanButtonState();
    updateScoreButtonState();

    // If both players are selected, auto-commit — UNLESS the dialog was
    // opened with a pre-selection (Full PBP path), in which case the user
    // gets to toggle modifier flags and commit explicitly via the Score
    // button. Without this guard, opening with both pre-selected would
    // fire on the first stray button click.
    if (selectedThrower && selectedReceiver && !suppressAutoFire) {
        commitScoreAttribution();
    }
}

// --- ES-module exports; the window shim below is transitional (removed at C10).
// showScoreAttributionDialog is imported by game/gameScreenEvents.js,
// playByPlay/fullPbp.js, and playByPlay/fieldPbp.js — no shim needed.
export { initializeScoreAttributionDialog, showScoreAttributionDialog };
// initializeScoreAttributionDialog: called bare (typeof-guarded) by main.js's
// DOMContentLoaded wiring — the guard resolves against window, so without this
// shim the dialog would silently never initialize.
window.initializeScoreAttributionDialog = initializeScoreAttributionDialog;
