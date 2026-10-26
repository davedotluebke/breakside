/*
 * Scrimmage variations — the in-game controls (store/scrimmageRules.js has
 * the rules, game/gameLogic.js the scoring entry points this file calls).
 *
 * Three things, all hidden unless the game's rules call for them:
 *   - the Simple panel's rules buttons: "No Score" (a drill rep whose
 *     possessions are used up), "Missed" (a conversion that failed), and
 *     under Bank "Bank N" / "Turnover". Simple mode records no turnovers, so
 *     these are the coach's call there. (Full and Field settle misses and
 *     forfeits from the turnover events themselves — see pbpPossession —
 *     but Bank N shows on every tab's panel row, since banking is a choice.)
 *   - the bank-or-press chooser that opens after every score under Bank,
 *     whichever surface recorded it.
 *   - a one-or-two-points chooser behind "They Score" when two-point plays
 *     are on. Our scores tick the box on the Score Attribution dialog.
 * The buttons follow the point state through the
 * `breakside:scrimmage-rules-changed` CustomEvent gameLogic dispatches; a
 * detail of { reason: 'score' } is what opens the chooser.
 */
import { Role } from '../store/models.js';
import { currentGame, getLatestPoint } from '../utils/helpers.js';
import { manualControls, conversionRule, pendingValueOf, twoPointPlaysEnabled } from '../store/scrimmageRules.js';
import {
    recordScore, settlePointAfterTurnover, bankPendingPoints, endPointWithoutScore,
} from './gameLogic.js';
import { canEditPlayByPlay, showControllerToast } from './controllerState.js';

const SLOT_IDS = ['pbpRulesBankBtn', 'pbpRulesEndBtn'];

/**
 * Show / hide / relabel the panel buttons for the current point. The first
 * control takes the first slot and so on; spare slots hide.
 * @param {boolean} enabled - the score buttons' enabled state (Active Coach, point live)
 */
function refreshRulesButtons(enabled) {
    const controls = manualControls(currentGame(), getLatestPoint());
    SLOT_IDS.forEach((id, i) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const control = controls[i];
        if (!control) {
            btn.style.display = 'none';
            return;
        }
        btn.style.display = '';
        btn.title = control.title;
        btn.dataset.kind = control.kind;
        const label = btn.querySelector('.pbp-btn-label');
        if (label) label.textContent = control.label;
        btn.disabled = !enabled;
        btn.classList.toggle('disabled', !enabled);
    });
}

/** A rules button tapped: act on the control it currently carries. */
function handlePbpRulesControl(btn) {
    if (!canEditPlayByPlay()) {
        showControllerToast('You need Play-by-Play control to record that', 'warning');
        return;
    }
    applyControl(btn && btn.dataset.kind);
}

function applyControl(kind) {
    if (kind === 'bank') bankPendingPoints();
    else if (kind === 'turnover' || kind === 'missed') settlePointAfterTurnover();
    else if (kind === 'dead') endPointWithoutScore();
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
    showChooser({
        id: 'opponentScoreValueModal',
        title: 'They scored — worth?',
        options: [
            { id: 'opponentScoreOneBtn', cls: 'ge-btn-who-them', icon: 'fa-minus-circle', label: '1 point', pick: () => recordScore(Role.OPPONENT, { twoPoint: false }) },
            { id: 'opponentScoreTwoBtn', cls: 'ge-btn-who-neither', icon: 'fa-star', label: '2 points', pick: () => recordScore(Role.OPPONENT, { twoPoint: true }) },
        ],
    });
}

/** After a score under Bank: bank the run, or press on. Closing = press on. */
function showBankChooser() {
    const game = currentGame();
    const point = getLatestPoint();
    if (!point || !point.pendingConversion) return;
    const n = pendingValueOf(point);
    const who = point.pendingConversion === Role.TEAM ? (game.team || 'We') : (game.opponent || 'They');
    showChooser({
        id: 'bankChooserModal',
        title: `${who}: ${n} unbanked`,
        options: [
            { id: 'bankChooserBankBtn', cls: 'ge-btn-who-us', icon: 'fa-piggy-bank', label: `Bank ${n}`, pick: () => bankPendingPoints() },
            { id: 'bankChooserPressBtn', cls: 'ge-btn-who-neither', icon: 'fa-forward', label: 'Press on', pick: () => {} },
        ],
    });
}

/** A two-button modal in the Game Events style; rebuilt on every open so labels stay current. */
function showChooser({ id, title, options }) {
    document.getElementById(id)?.remove();
    const modal = document.createElement('div');
    modal.id = id;
    modal.className = 'modal game-events-modal';
    modal.innerHTML = `
        <div class="modal-content game-events-modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2></h2>
                <span class="close">&times;</span>
            </div>
            <div class="game-events-buttons timeout-who-buttons">
                ${options.map(o => `
                <button id="${o.id}" class="ge-btn ${o.cls}">
                    <i class="fas ${o.icon}"></i>
                    <span></span>
                </button>`).join('')}
            </div>
        </div>
    `;
    modal.querySelector('h2').textContent = title;
    options.forEach(o => { modal.querySelector(`#${o.id} span`).textContent = o.label; });
    document.body.appendChild(modal);
    const hide = () => modal.remove();
    modal.querySelector('.close').onclick = hide;
    modal.onclick = (e) => { if (e.target === modal) hide(); };
    options.forEach(o => {
        modal.querySelector(`#${o.id}`).onclick = () => { hide(); o.pick(); };
    });
    modal.style.display = 'flex';
}

// The point state changed under the rules (a score went pending, a run was
// banked or forfeited, a score was undone): relabel the buttons, and after a
// Bank score ask bank-or-press. The panel's own state update covers the
// enabled flag; here only visibility and labels.
document.addEventListener('breakside:scrimmage-rules-changed', (e) => {
    const anyEnabled = SLOT_IDS.some(id => { const b = document.getElementById(id); return b && !b.disabled; });
    refreshRulesButtons(anyEnabled);
    const reason = e.detail && e.detail.reason;
    if (reason === 'score' && conversionRule(currentGame()) === 'bank') showBankChooser();
});

export { refreshRulesButtons, handlePbpRulesControl, recordOpponentScore };
