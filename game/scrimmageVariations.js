/*
 * Scrimmage variations — the in-game controls (store/scrimmageRules.js has
 * the rules, game/gameLogic.js the scoring entry points this file calls).
 *
 * Two things only, both on the Simple play-by-play panel, both hidden unless
 * the game's rules call for them:
 *   - the "No Score" / "Missed" button: Simple mode records no turnovers, so
 *     a drill rep whose possessions are used up, or a conversion that was
 *     missed, is the coach's call. (Full and Field settle these from the
 *     turnover events themselves — see pbpPossession.)
 *   - a one-or-two-points chooser behind "They Score" when two-point plays
 *     are on. Our scores tick the box on the Score Attribution dialog.
 * The button follows the point state through the
 * `breakside:scrimmage-rules-changed` CustomEvent gameLogic dispatches.
 */
import { Role } from '../store/models.js';
import { currentGame, getLatestPoint } from '../utils/helpers.js';
import { manualEndControl, twoPointPlaysEnabled } from '../store/scrimmageRules.js';
import { recordScore, settlePointAfterTurnover, endPointWithoutScore } from './gameLogic.js';
import { canEditPlayByPlay, showControllerToast } from './controllerState.js';

/**
 * Show / hide / relabel the panel button for the current point.
 * @param {boolean} enabled - the score buttons' enabled state (Active Coach, point live)
 */
function refreshRulesEndButton(enabled) {
    const btn = document.getElementById('pbpRulesEndBtn');
    if (!btn) return;
    const control = manualEndControl(currentGame(), getLatestPoint());
    if (!control) {
        btn.style.display = 'none';
        return;
    }
    btn.style.display = '';
    btn.title = control.title;
    btn.dataset.kind = control.kind;
    const label = document.getElementById('pbpRulesEndLabel');
    if (label) label.textContent = control.label;
    btn.disabled = !enabled;
    btn.classList.toggle('disabled', !enabled);
}

/** The button: end the rep with no score, or resolve a pending conversion as missed. */
function handlePbpRulesEnd() {
    if (!canEditPlayByPlay()) {
        showControllerToast('You need Play-by-Play control to record that', 'warning');
        return;
    }
    const control = manualEndControl(currentGame(), getLatestPoint());
    if (!control) return;
    if (control.kind === 'missed') settlePointAfterTurnover();
    else endPointWithoutScore();
}

/**
 * "They Score": straight to recordScore unless two-point plays are on, in
 * which case a small chooser asks how much the score was worth.
 */
function recordOpponentScore() {
    if (!twoPointPlaysEnabled(currentGame())) {
        recordScore(Role.OPPONENT);
        return;
    }
    showOpponentScoreChooser(twoPoint => recordScore(Role.OPPONENT, { twoPoint }));
}

function showOpponentScoreChooser(onPick) {
    let modal = document.getElementById('opponentScoreValueModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'opponentScoreValueModal';
        modal.className = 'modal game-events-modal';
        modal.innerHTML = `
            <div class="modal-content game-events-modal-content">
                <div class="dialog-header prominent-dialog-header">
                    <h2>They scored — worth?</h2>
                    <span class="close" id="opponentScoreValueClose">&times;</span>
                </div>
                <div class="game-events-buttons timeout-who-buttons">
                    <button id="opponentScoreOneBtn" class="ge-btn ge-btn-who-them">
                        <i class="fas fa-minus-circle"></i>
                        <span>1 point</span>
                    </button>
                    <button id="opponentScoreTwoBtn" class="ge-btn ge-btn-who-neither">
                        <i class="fas fa-star"></i>
                        <span>2 points</span>
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    const hide = () => { modal.style.display = 'none'; };
    modal.querySelector('#opponentScoreValueClose').onclick = hide;
    modal.onclick = (e) => { if (e.target === modal) hide(); };
    modal.querySelector('#opponentScoreOneBtn').onclick = () => { hide(); onPick(false); };
    modal.querySelector('#opponentScoreTwoBtn').onclick = () => { hide(); onPick(true); };
    modal.style.display = 'flex';
}

// The point state changed under the rules (a conversion became pending or
// was resolved, a score was undone): relabel the button. The panel's own
// state update covers the enabled flag; here only visibility and label.
document.addEventListener('breakside:scrimmage-rules-changed', () => {
    const btn = document.getElementById('pbpRulesEndBtn');
    refreshRulesEndButton(!!btn && !btn.disabled);
});

export { refreshRulesEndButton, handlePbpRulesEnd, recordOpponentScore };
