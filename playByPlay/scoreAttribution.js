/*
 * Score Attribution Dialog
 * Handles the "We Score" player attribution dialog (thrower/receiver selection).
 * Extracted from simpleModeScreen.js during legacy screen cleanup.
 */

// Track selected players for score attribution
let selectedThrower = null;
let selectedReceiver = null;

// When true, having both thrower and receiver selected does NOT auto-
// create the score event. Set to true when the dialog is opened with
// pre-selections from Full PBP (or anywhere else that has thrower/
// receiver context up front), so the user has time to tap modifier
// flags before committing. The Score button is the explicit commit in
// that case. Cleared on every showScoreAttributionDialog() call.
let suppressAutoFire = false;

/**
 * Initialize score attribution dialog event handlers
 * Should be called after DOM is ready
 */
function initializeScoreAttributionDialog() {
    const callahanBtn = document.getElementById('callahanBtn');
    const skipAttributionBtn = document.getElementById('skipAttributionBtn');
    const scoreConfirmBtn = document.getElementById('scoreConfirmBtn');
    const scoreAttributionDialogClose = document.querySelector('#scoreAttributionDialog .close');

    // Explicit "Score" commit button. Same code path as the auto-fire
    // branch in handleScoreAttribution. Enabled only when both thrower
    // and receiver are selected.
    if (scoreConfirmBtn) {
        scoreConfirmBtn.addEventListener('click', () => {
            if (!selectedThrower || !selectedReceiver) return;
            commitScoreAttribution();
        });
    }

    if (callahanBtn) {
        callahanBtn.addEventListener('click', function() {
            const dialog = document.getElementById('scoreAttributionDialog');
            // Use whichever player is selected (receiver or thrower) as the defender who caught the Callahan
            const defender = selectedReceiver || selectedThrower || null;
            const callahanEvent = new Defense({
                defender: defender,
                Callahan: true
            });
            const point = getLatestPoint();
            point.addPossession(new Possession(false));
            getActivePossession(point).addEvent(callahanEvent);

            // Award goal to the defender who caught the Callahan
            if (defender) {
                defender.goals++;
            } else {
                console.log("Warning: no defender selected for Callahan");
            }

            updateScore(Role.TEAM);
            dialog.style.display = 'none';
            moveToNextPoint();
        });
    }

    if (skipAttributionBtn) {
        skipAttributionBtn.addEventListener('click', function() {
            const dialog = document.getElementById('scoreAttributionDialog');
            // Create scoring throw with Unknown Player (so undo can find it)
            const scoreEvent = new Throw({
                thrower: UNKNOWN_PLAYER_OBJ,
                receiver: UNKNOWN_PLAYER_OBJ,
                score: true
            });
            const point = getLatestPoint();
            point.addPossession(new Possession(true));
            getActivePossession(point).addEvent(scoreEvent);
            UNKNOWN_PLAYER_OBJ.completedPasses++;
            UNKNOWN_PLAYER_OBJ.assists++;
            UNKNOWN_PLAYER_OBJ.goals++;

            updateScore(Role.TEAM);
            dialog.style.display = 'none';
            moveToNextPoint();
        });
    }

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
}

/**
 * Open the Score Attribution dialog, optionally with thrower / receiver
 * pre-selected and modifier flags pre-checked.
 *
 * @param {object} [opts]
 * @param {Player|null} [opts.thrower]    Pre-select this player as thrower.
 * @param {Player|null} [opts.receiver]   Pre-select this player as receiver.
 * @param {boolean}    [opts.breakArmed] Pre-check the Break modifier.
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

    // Reset checkbox flags
    document.getElementById('huckFlag').checked = false;
    document.getElementById('breakFlag').checked = !!opts.breakArmed;
    document.getElementById('skyFlag').checked = false;
    document.getElementById('layoutFlag').checked = false;
    document.getElementById('hammerFlag').checked = false;

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
            if (btn.textContent === throwerName) btn.classList.add('selected');
        });
        if (throwerName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.textContent === throwerName) {
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
            if (btn.textContent === receiverName) btn.classList.add('selected');
        });
        if (receiverName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.textContent === receiverName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    }

    // Initialize Callahan + Score button states.
    updateCallahanButtonState();
    updateScoreButtonState();

    // Show dialog
    dialog.style.display = 'block';
}

function createPlayerButton(playerName) {
    const button = document.createElement('button');
    button.textContent = playerName;
    button.classList.add('player-button');
    if (playerName === UNKNOWN_PLAYER) {
        button.classList.add('unknown-player');
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
    const dialog = document.getElementById('scoreAttributionDialog');

    const scoreEvent = new Throw({
        thrower: selectedThrower,
        receiver: selectedReceiver,
        score: true,
        huck: document.getElementById('huckFlag').checked,
        breakmark: document.getElementById('breakFlag').checked,
        sky: document.getElementById('skyFlag').checked,
        layout: document.getElementById('layoutFlag').checked,
        hammer: document.getElementById('hammerFlag').checked
    });

    // Attach to the current offensive possession if one exists, otherwise
    // create a new offensive possession. Previously this always created a
    // new possession, which would orphan any in-point events the user
    // entered via Full PBP / narration earlier.
    const possession = (typeof ensurePossessionExists === 'function')
        ? ensurePossessionExists(true)
        : (() => {
            const point = getLatestPoint();
            const p = new Possession(true);
            point.addPossession(p);
            return p;
        })();
    possession.addEvent(scoreEvent);

    // Stats: scoring throw counts as a completed pass for the thrower,
    // an assist for them, and a goal for the receiver. (The old version
    // skipped the completedPass increment — fixed here while we're at it
    // so Simple-mode + Full-PBP score events update stats identically.)
    if (typeof selectedThrower.completedPasses !== 'number') {
        selectedThrower.completedPasses = 0;
    }
    selectedThrower.completedPasses += 1;
    selectedThrower.assists = (selectedThrower.assists || 0) + 1;
    selectedReceiver.goals = (selectedReceiver.goals || 0) + 1;

    updateScore(Role.TEAM);
    if (dialog) dialog.style.display = 'none';
    moveToNextPoint();
}

function handleScoreAttribution(playerName, isThrower, buttonElement) {
    const player = getPlayerFromName(playerName);

    // Check if this button is already selected
    if (buttonElement.classList.contains('selected')) {
        buttonElement.classList.remove('selected');
        if (isThrower) {
            selectedThrower = null;
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        } else {
            selectedReceiver = null;
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
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
                if (btn.textContent === previousThrowerName) {
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
                if (btn.textContent === playerName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    } else {
        if (selectedReceiver) {
            const previousReceiverName = selectedReceiver.name;
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.textContent === previousReceiverName) {
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
                if (btn.textContent === playerName) {
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
