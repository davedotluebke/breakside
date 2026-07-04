/*
 * Tiny debug logger (F3 console sweep).
 *
 * The app's chatty console.log call sites route through log() so production
 * consoles stay quiet by default; console.warn / console.error are left
 * alone everywhere for real problems.
 *
 * Debug logging is ON when any of these hold:
 *   - ?debug=1 in the URL (persisted to localStorage, like ?api=;
 *     ?debug=0 turns it back off)
 *   - localStorage breakside_debug === 'true'
 *   - running on localhost (dev servers)
 * Runtime toggle from the console: setDebugLogging(true|false).
 *
 * Zero imports by design — this sits below the Data layer so any module
 * (including store/) can import it without ordering concerns.
 */

const DEBUG_KEY = 'breakside_debug';

function computeEnabled() {
    try {
        const qs = new URLSearchParams(window.location.search);
        if (qs.has('debug')) {
            const v = qs.get('debug');
            const on = v !== '0' && v !== 'false';
            localStorage.setItem(DEBUG_KEY, on ? 'true' : 'false');
            return on;
        }
        if (localStorage.getItem(DEBUG_KEY) === 'true') return true;
        return ['localhost', '127.0.0.1'].includes(window.location.hostname);
    } catch (_) {
        return false;
    }
}

let enabled = computeEnabled();

/** Debug log — forwarded to console.log only when debug logging is on. */
function log(...args) {
    if (enabled) console.log(...args);
}

function setDebugLogging(on) {
    enabled = !!on;
    try { localStorage.setItem(DEBUG_KEY, on ? 'true' : 'false'); } catch (_) { /* ignore */ }
    console.log(`Debug logging ${enabled ? 'enabled' : 'disabled'}`);
}

function isDebugLogging() { return enabled; }

export { log, setDebugLogging, isDebugLogging };
// window survivor: debug seam (console toggle for verbose logging; no in-app UI)
window.setDebugLogging = setDebugLogging;
