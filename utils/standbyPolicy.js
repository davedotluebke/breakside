/*
 * Standby timer policy — the pure rules for entering standby by itself.
 *
 * A pure leaf module: no DOM, no timers, no imports, no side effects, so the
 * gate table and the toast wording can be unit-tested directly
 * (tests/unit/standbyPolicy.test.mjs). The runtime half — the idle clock, the
 * countdown toast and the soft fade-in — is ui/standbyTimer.js.
 *
 * The gate exists because entering standby uninvited has a failure mode the
 * explicit ☀ tap does not: the screen can go black at the moment a coach
 * reaches for a control. Every rule below names a moment when that would
 * cost something real.
 */

/** Seconds the warning toast counts down before the fade-in starts. */
export const COUNTDOWN_SECONDS = 5;
/** Default idle time (power.standbyIdleSec) before the warning. */
export const DEFAULT_IDLE_SECONDS = 60;
/** Cap on the idle time; anything above is clamped, not rejected. */
export const MAX_IDLE_SECONDS = 3600;

/**
 * The idle time as stored (a select gives strings; a console user may give
 * anything) → seconds, or 0 for "never".
 * @param {*} raw
 * @returns {number}
 */
export function normalizeIdleSeconds(raw) {
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_IDLE_SECONDS, n);
}

/**
 * May the idle timer take the screen to standby right now?
 *
 * Checked when the idle clock fires and again on every countdown tick, so a
 * state change during the five-second warning (a dialog opening, the point
 * starting) cancels it.
 *
 * @param {object} ctx
 * @param {boolean} ctx.enabled         - the timer is on and the idle time is > 0
 * @param {boolean} ctx.inGame          - the game screen is mounted
 * @param {boolean} ctx.visible         - the page is visible
 * @param {boolean} ctx.standbyActive   - standby is already up (or fading in)
 * @param {boolean} ctx.dialogOpen      - any dialog, popover or menu is open
 * @param {boolean} ctx.micBusy         - a narration recording is running or connecting
 * @param {boolean} ctx.activeCoach     - this device holds Active Coach
 * @param {boolean} ctx.pointInProgress - a point is being played
 * @param {string}  ctx.activeTab       - 'simple' | 'full' | 'field' | 'line' | 'log' | 'all'
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function idleStandbyGate(ctx) {
    const c = ctx || {};
    const block = (reason) => ({ allowed: false, reason });

    if (!c.enabled) return block('disabled');
    if (!c.inGame) return block('not-in-game');
    if (!c.visible) return block('hidden');
    if (c.standbyActive) return block('already-in-standby');
    // A dialog is a question waiting for an answer; going black hides it.
    if (c.dialogOpen) return block('dialog-open');
    // The mic is a deliberate, attended act, and its button lives under the overlay.
    if (c.micBusy) return block('mic-busy');
    // The Active Coach mid-point is recording throws; a swallowed wake tap
    // there costs an event.
    if (c.activeCoach && c.pointInProgress) return block('active-coach-mid-point');
    // Full and Field are the Active Coach's working surfaces between points
    // too. Anyone else on those tabs is most likely there by accident, so
    // they are not held.
    if (c.activeCoach && (c.activeTab === 'full' || c.activeTab === 'field')) return block('active-coach-pbp-tab');

    return { allowed: true, reason: null };
}

function plural(n, word) {
    return n === 1 ? word : word + 's';
}

/**
 * The warning toast's inner HTML: the countdown number is bold so a coach
 * glancing up sees it move, and the hint line is small because it is the
 * same every time.
 * @param {number} idleSeconds - the idle time that just elapsed
 * @param {number} remaining   - seconds until the fade-in
 * @returns {string}
 */
export function idleToastMarkup(idleSeconds, remaining) {
    const idle = Math.max(0, Math.round(idleSeconds));
    const left = Math.max(0, Math.round(remaining));
    return `Idle for ${idle} ${plural(idle, 'second')}, entering standby in <strong>${left}</strong> ${plural(left, 'second')}` +
        '<br><small class="toast-sub">Long-press ☀ to toggle standby timer</small>';
}
