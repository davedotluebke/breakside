/*
 * Standby timer — enter the black standby screen by itself after an idle
 * spell, with a warning first and a way out at every step.
 *
 * The explicit ☀ tap (ui/standbyScreen.js) only saves battery when a coach
 * remembers to use it, and the moments a lit screen sits idle longest — a
 * long point, a timeout, halftime — are exactly the moments nobody is
 * thinking about the phone. So: after `power.standbyIdleSec` seconds with no
 * tap or key, a toast counts down five seconds, then the overlay fades in
 * *without* taking the tap — a touch during the fade reaches the game UI and
 * cancels the standby — and only once fully in does it become the usual
 * tap-swallowing black screen.
 *
 * Three ways to say "not now", all of which also restart the idle clock:
 *   - any tap or key anywhere during the countdown or the fade
 *   - dismissing the toast (tap, × or swipe), which is itself a tap
 *   - press-and-hold ☀ in the game header, which turns the timer off
 *     (persisted, so it stays off until turned back on)
 *
 * The gate (utils/standbyPolicy.js) is checked when the idle clock fires and
 * again on every countdown tick: never for the Active Coach mid-point or on
 * the Full/Field tabs, never with a dialog open or the mic on. A held gate
 * just re-arms the clock — the next idle period is measured from the last
 * input, so the moment the point ends the clock is already running.
 *
 * Power: this owns no recurring loop. The idle clock is one setTimeout,
 * re-armed on input; the countdown is five 1-second ticks. Both are counted
 * under `standbyIdle` in the battery report. Input listeners run in the
 * capture phase so a tap the standby overlay swallows still resets the clock.
 */
import { powerManager } from '../utils/powerManager.js';
import {
    idleStandbyGate, idleToastMarkup, normalizeIdleSeconds,
    COUNTDOWN_SECONDS, DEFAULT_IDLE_SECONDS,
} from '../utils/standbyPolicy.js';
import { isPointInProgress } from '../utils/helpers.js';
import { getActiveTab } from './panelSystem.js';
import { standbyScreen } from './standbyScreen.js';
import { isActiveCoach, showControllerToast, dismissToast } from '../game/controllerState.js';
import { log } from '../utils/logger.js';

const standbyTimer = (function() {
    const ENABLED_KEY = 'power.standbyTimer';
    const SECONDS_KEY = 'power.standbyIdleSec';
    const WAKEUP_ID = 'standbyIdle';
    // pointerdown covers touch, pen and mouse; wheel is the one desktop
    // gesture that is neither.
    const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'];
    // Anything that is a question waiting for an answer. Static modals in
    // index.html sit at display:none until opened; dynamic ones exist only
    // while open. The popovers are the set picker and the line-mode menu.
    const DIALOG_SELECTOR = [
        '.modal', '.set-picker-pop', '.line-mode-menu',
        '#pullDialog', '#scoreAttributionDialog', '#keyPlayDialog',
        '#editPlayerDialog', '#eraseDialog', '#pendingSyncDialog', '#changePasswordDialog',
    ].join(', ');

    let armed = false;
    let idleTimer = null;
    let countdownTimer = null;
    let remaining = 0;
    /** @type {HTMLElement|null} the warning toast while it is up */
    let toast = null;
    // Set while we dismiss the toast ourselves, so its onDismiss (which means
    // "the coach dismissed it") is not mistaken for a cancel.
    let dismissingSelf = false;

    // ─── Settings (late-bound: settings/ evaluates above ui/) ───────────────

    function settings() {
        const s = window.advancedSettings;
        const enabled = s && typeof s.get === 'function' ? s.get(ENABLED_KEY) : undefined;
        const raw = s && typeof s.get === 'function' ? s.get(SECONDS_KEY) : undefined;
        return {
            enabled: enabled === undefined ? true : !!enabled,
            seconds: raw === undefined ? DEFAULT_IDLE_SECONDS : normalizeIdleSeconds(raw)
        };
    }

    function isEnabled() {
        return settings().enabled;
    }

    function idleSeconds() {
        return settings().seconds;
    }

    /** Turn the timer on or off (persisted) and apply it at once. */
    function setEnabled(on) {
        window.advancedSettings?.set?.(ENABLED_KEY, !!on);
        log(`🌙 Standby timer ${on ? 'on' : 'off'}`);
        refresh();
    }

    // ─── Gate inputs ────────────────────────────────────────────────────────

    function isShown(el) {
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
    }

    function anyDialogOpen() {
        return Array.prototype.some.call(document.querySelectorAll(DIALOG_SELECTOR), isShown);
    }

    // The mic button carries the engine's phase as a class; reading it here
    // avoids importing narration/ upward from ui/.
    function micBusy() {
        const btn = document.getElementById('narrationMicBtn');
        return !!btn && (btn.classList.contains('mic-recording') || btn.classList.contains('mic-connecting'));
    }

    function context() {
        const { enabled, seconds } = settings();
        const ctx = powerManager.getContext();
        return {
            enabled: enabled && seconds > 0,
            inGame: !!ctx.inGame,
            visible: !!ctx.visible,
            standbyActive: standbyScreen.isActive(),
            dialogOpen: anyDialogOpen(),
            micBusy: micBusy(),
            activeCoach: !!isActiveCoach(),
            pointInProgress: !!isPointInProgress(),
            activeTab: getActiveTab()
        };
    }

    // ─── Idle clock ─────────────────────────────────────────────────────────

    function clearIdle() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    /** (Re)start the idle period from now. */
    function scheduleIdle() {
        clearIdle();
        if (!armed) return;
        const { enabled, seconds } = settings();
        if (!enabled || seconds <= 0) return;
        if (standbyScreen.isActive()) return;   // nothing to do until it is tapped away
        idleTimer = setTimeout(onIdle, seconds * 1000);
    }

    function onIdle() {
        idleTimer = null;
        window.powerLog?.countWakeup?.(WAKEUP_ID);
        const gate = idleStandbyGate(context());
        if (!gate.allowed) {
            log(`🌙 Idle, standby held: ${gate.reason}`);
            scheduleIdle();
            return;
        }
        startCountdown();
    }

    /** Any tap or key: the coach is here. Cancel whatever is pending, restart the clock. */
    function onInput() {
        if (countdownTimer || toast) cancelCountdown('input');
        if (standbyScreen.isEntering()) standbyScreen.cancelEntering('input');
        scheduleIdle();
    }

    // ─── Countdown toast ────────────────────────────────────────────────────

    function updateToast() {
        const el = toast && toast.querySelector('.toast-message');
        if (el) el.innerHTML = idleToastMarkup(settings().seconds, remaining);
    }

    function startCountdown() {
        remaining = COUNTDOWN_SECONDS;
        toast = showControllerToast(
            idleToastMarkup(settings().seconds, remaining),
            'info',
            0,   // persistent: we take it down ourselves
            {
                onTap: () => cancelCountdown('toast-tap'),
                onDismiss: () => { if (!dismissingSelf) cancelCountdown('toast-dismiss'); }
            }
        );
        if (toast) toast.classList.add('toast-standby');
        countdownTimer = setInterval(tick, 1000);
        log('🌙 Idle: standby countdown started');
    }

    function tick() {
        window.powerLog?.countWakeup?.(WAKEUP_ID);
        const gate = idleStandbyGate(context());
        if (!gate.allowed) {
            cancelCountdown(gate.reason);
            return;
        }
        remaining -= 1;
        if (remaining <= 0) {
            finishCountdown();
            return;
        }
        updateToast();
    }

    function takeDownToast() {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        if (!toast) return;
        const t = toast;
        toast = null;
        dismissingSelf = true;
        try { dismissToast(t); } finally { dismissingSelf = false; }
    }

    function finishCountdown() {
        takeDownToast();
        // Soft: visible but not yet the tap target, so a touch during the
        // fade reaches the UI and lands in onInput, which cancels it.
        standbyScreen.enter({ soft: true });
    }

    function cancelCountdown(reason) {
        const had = !!(toast || countdownTimer);
        takeDownToast();
        if (had) log(`🌙 Standby countdown cancelled (${reason})`);
        scheduleIdle();
    }

    // ─── Arming ─────────────────────────────────────────────────────────────

    const listenerOpts = { capture: true, passive: true };

    function arm() {
        if (armed) return;
        armed = true;
        INPUT_EVENTS.forEach(type => document.addEventListener(type, onInput, listenerOpts));
        scheduleIdle();
    }

    function disarm() {
        if (!armed) return;
        armed = false;
        INPUT_EVENTS.forEach(type => document.removeEventListener(type, onInput, listenerOpts));
        takeDownToast();
        if (standbyScreen.isEntering()) standbyScreen.cancelEntering('disarm');
        clearIdle();
    }

    /** Re-read the settings and apply them: called after a settings change. */
    function refresh() {
        const { enabled, seconds } = settings();
        if (!enabled || seconds <= 0) {
            takeDownToast();
            if (standbyScreen.isEntering()) standbyScreen.cancelEntering('timer-off');
            clearIdle();
            return;
        }
        scheduleIdle();
    }

    // In a game and visible → armed; anything else → not. The plan carries
    // the whole context, so a missed edge still converges.
    document.addEventListener('breakside:power-plan', (e) => {
        const ctx = e.detail && e.detail.ctx;
        if (!ctx) return;
        if (ctx.inGame && ctx.visible) arm(); else disarm();
    });

    // Leaving standby starts a fresh idle period; entering it (by tap or by
    // us) stops the clock until then.
    document.addEventListener(standbyScreen.CHANGED_EVENT, (e) => {
        if (e.detail && e.detail.active) clearIdle(); else scheduleIdle();
    });

    return { isEnabled, setEnabled, idleSeconds, refresh, COUNTDOWN_SECONDS };
})();

// --- ES-module export ---
export { standbyTimer };
// window survivor: late-bound accessor for settings/advancedSettings.js
// (evaluates before this file; re-applies the timer when its two settings
// change) and an e2e seam (tests/scenarios/17-standby-timer.spec.ts sets a
// short idle time).
window.standbyTimer = standbyTimer;
