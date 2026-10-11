/*
 * The "Clock stopped" toast (ARCHITECTURE.md § Point clock → Stoppages).
 *
 * A timeout, an injury sub or the header pause button stops the point clock
 * (store/pointClock.js stopPointClock); this toast tells the coach, counts
 * how long it has been stopped, and offers a Restart button. It never
 * expires on its own: it goes when the coach dismisses it (×, swipe) or when
 * the clock restarts — on the next recorded play, the button here, or the
 * header play button.
 *
 * The toast is *reconciled from point state*, not shown and hidden by the
 * stop and restart call sites: refresh() compares what the DOM shows with
 * what the live point says and fixes the difference. gameTimer.js calls it
 * on every 1 s repaint and after the pause button, the hooks call it right
 * after a stop, and the standby screen's change event calls it on enter and
 * exit. That is what makes the toast survive a reload (the stopped state is
 * persisted with the point), a sync refresh that replaces game.points, and
 * the standby screen: toasts sit above the black overlay, so this one hides
 * while standby is up (lit pixels, and a Restart button tappable in the
 * dark) and is rebuilt on the way out.
 *
 * Only the device that can record play-by-play shows it (canEditPlayByPlay —
 * solo, or the Active Coach): the Line Coach cannot enter the play that
 * restarts the clock, and sees the frozen header chip instead.
 */
import { saveAllTeamsData } from '../store/storage.js';
import {
    isPointClockStopped, restartPointClock, clockStoppedForMs,
} from '../store/pointClock.js';
import { getLatestPoint } from '../utils/helpers.js';
import { isGameScreenVisible } from '../ui/panelSystem.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { showControllerToast, dismissToast, canEditPlayByPlay } from './controllerState.js';
import { log } from '../utils/logger.js';

const REASON_LABELS = Object.freeze({
    timeout: 'timeout',
    injury: 'injury sub',
    manual: 'paused',
});

let toast = null;              // the live toast element, or null
let toastStopKey = null;       // the stop (lastPauseTime ms) the toast was built for
let dismissedStopKey = null;   // a stop the coach dismissed the toast for: stay quiet until the next stop
// Set while this module removes the toast itself (restart, standby, point
// over), so the toast's onDismiss does not count as the coach dismissing it.
let removingOurselves = false;

function stopKeyOf(point) {
    return point && point.lastPauseTime ? new Date(point.lastPauseTime).getTime() : 0;
}

function formatStopped(ms) {
    const total = Math.floor(ms / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

// What the standby screen last reported (its change event fires at the
// start of a fade, in both directions). Until it has reported, fall back to
// the body class it keeps. The event is read rather than the class because
// on the way out the class stays on through the 180 ms leaving fade, and
// the toast should be back as the fade starts, not a tick later.
let standbyReported = null;   // { active, entering } | null

function standbyUp() {
    if (standbyReported) return !!(standbyReported.active || standbyReported.entering);
    return !!(document.body && document.body.classList.contains('standby-active'));
}

// The Sub Players dialog stops the clock as it opens (the coach reaching
// for Injury Sub is the stoppage); the toast waits until the dialog has
// closed, then shows the time since. hideSubPlayersModal repaints the chip,
// which reconciles the toast at once.
function subDialogUp() {
    const modal = document.getElementById('subPlayersModal');
    return !!modal && modal.style.display !== 'none' && modal.style.display !== '';
}

function removeToast() {
    if (!toast) return;
    const el = toast;
    toast = null;
    toastStopKey = null;
    removingOurselves = true;
    try { dismissToast(el); } finally { removingOurselves = false; }
}

function restartFromToast() {
    const point = getLatestPoint();
    if (restartPointClock(point)) {
        logEvent('Point clock restarted');
        log('⏱ Point clock restarted — toast');
        saveAllTeamsData();
    }
    // Repaint the chip (and, through it, the pause button) now rather than
    // on the next tick. gameTimer.js imports this module, so the back-edge
    // is its existing window survivor.
    window.updateTimerDisplay?.();
}

function buildToast(point) {
    const reason = REASON_LABELS[point.clockStopped] || 'paused';
    const message = `<strong>Clock stopped</strong> — ${reason} · ` +
        `<span class="clock-stopped-for">${formatStopped(clockStoppedForMs(point))}</span>` +
        '<br><small class="toast-sub">Restarts on the next play you record</small>';
    const el = showControllerToast(message, 'warning', 0, {
        actions: [{ label: 'Restart clock', onClick: restartFromToast }],
        onDismiss: () => {
            if (removingOurselves) return;
            // The coach closed it: stay quiet for this stop. The header play
            // button (and the next play) still restart the clock.
            dismissedStopKey = toastStopKey;
            toast = null;
            toastStopKey = null;
        },
    });
    if (!el) return;
    el.classList.add('toast-clock-stopped');
    toast = el;
    toastStopKey = stopKeyOf(point);
}

/**
 * Make the toast match the live point: show it while the clock is stopped
 * (on a device that records play-by-play, with standby down, unless the
 * coach dismissed it for this stop), keep its counter current, and remove
 * it otherwise. Cheap when nothing changed; safe to call every second.
 */
export function refreshClockStoppedToast() {
    const point = getLatestPoint();
    const stopped = isPointClockStopped(point);
    const key = stopped ? stopKeyOf(point) : 0;
    const wanted = stopped && isGameScreenVisible() && !standbyUp() && !subDialogUp() &&
        canEditPlayByPlay() && key !== dismissedStopKey;

    if (!wanted) {
        if (toast) removeToast();
        // A new stop (or none) clears a dismissal that was for an older one.
        if (!stopped) dismissedStopKey = null;
        return;
    }
    if (toast && toastStopKey !== key) removeToast();   // a different stop: rebuild
    if (!toast) {
        buildToast(point);
        return;
    }
    const counter = toast.querySelector('.clock-stopped-for');
    if (counter) {
        const text = formatStopped(clockStoppedForMs(point));
        if (counter.textContent !== text) counter.textContent = text;
    }
}

// Standby: hide on the way in, rebuild on the way out. The event fires at
// the start of the leaving fade (the overlay still swallows taps until it
// finishes), so the toast is back before the coach can reach for it.
document.addEventListener('breakside:standby-changed', (e) => {
    const d = e.detail || {};
    standbyReported = { active: !!d.active, entering: !!d.entering };
    refreshClockStoppedToast();
});

// Leaving the game screen: nothing to tell anyone. The power plan's inGame
// context flag is the game screen's own lifecycle signal (ui/standbyScreen.js
// keys its teardown off the same event).
document.addEventListener('breakside:power-plan', (e) => {
    const ctx = e.detail && e.detail.ctx;
    if (ctx && !ctx.inGame && toast) removeToast();
});
