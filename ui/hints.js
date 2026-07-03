/*
 * New-user hints — lightweight, dismissable nudges shown as info toasts.
 *
 * Each hint has a stable id and fires at most once per calendar day for that
 * id. The "Hide all hints" advanced setting (hints.hideAll) suppresses every
 * hint outright. Add new hints by calling window.hints.maybeShow('<id>', '<msg>')
 * from wherever the teachable moment occurs — no per-hint plumbing needed.
 *
 * Depends (at call time, not load time) on showControllerToast (controllerState.js)
 * and window.advancedSettings (advancedSettings.js).
 */
import { showControllerToast } from '../game/controllerState.js';

const hints = (function() {
    const STAMP_PREFIX = 'breakside_hint_';

    function todayStr() {
        // Local calendar day — YYYY-MM-DD.
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd}`;
    }

    function hintsHidden() {
        return !!(window.advancedSettings &&
                  typeof window.advancedSettings.get === 'function' &&
                  window.advancedSettings.get('hints.hideAll'));
    }

    /**
     * Show `message` as an info toast at most once per calendar day for `id`,
     * unless hints are globally hidden. Returns true if a toast was shown.
     *
     * @param {string} id       Stable hint identifier (used for the daily stamp).
     * @param {string} message  Toast text.
     * @param {object} [opts]    { type='info', duration=5000 }
     */
    function maybeShow(id, message, opts) {
        opts = opts || {};
        if (hintsHidden()) return false;

        const key = STAMP_PREFIX + id;
        let last = null;
        try { last = localStorage.getItem(key); } catch (_) { /* ignore */ }
        if (last === todayStr()) return false;

        if (typeof showControllerToast !== 'function') return false;
        showControllerToast(message, opts.type || 'info', opts.duration || 5000);

        try { localStorage.setItem(key, todayStr()); } catch (_) { /* ignore */ }
        return true;
    }

    /**
     * Forget every hint's "already shown today" stamp, so each hint can fire
     * again. Used by the "Hide all hints" toggle to let users (and us, when
     * testing new hints) bring the hints back.
     */
    function resetAll() {
        let keys = [];
        try { keys = Object.keys(localStorage); } catch (_) { return; }
        keys.forEach(k => {
            if (k.indexOf(STAMP_PREFIX) === 0) {
                try { localStorage.removeItem(k); } catch (_) { /* ignore */ }
            }
        });
    }

    return { maybeShow, resetAll };
})();

// --- ES-module export ---
export { hints };
// window survivor: late-bound back-edge hook (read window-qualified by
// settings/advancedSettings.js — evaluates before this file — and
// playByPlay/fieldPbp.js)
window.hints = hints;
