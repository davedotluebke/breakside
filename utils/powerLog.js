/*
 * Power log — what the app actually did this session.
 *
 * TODO.md § Battery says "instrument before you optimize". The obvious way to
 * do that is `navigator.getBattery()`, and on the phones that matter most it
 * does not exist: the Battery Status API was never shipped in WebKit and was
 * removed from Firefox, so on iPhone there is no reading to take. Coaches here
 * are split across iPhone and Android, so battery deltas alone would give us
 * data for half the field and nothing for the other half.
 *
 * So the primary signal is an activity proxy rather than a battery reading:
 * count the things we control — timer wakeups, network requests, seconds with
 * the mic open, seconds holding a wake lock, seconds actually on screen. Those
 * work everywhere, and they measure the levers directly instead of measuring a
 * number that mixes in screen brightness, cell signal, and whatever else the
 * phone was doing. Where `getBattery()` does exist we also record real level
 * snapshots, as a cross-check on the proxy.
 *
 * Read it from the Online/About overlay, which has a copy button for pasting
 * into a field report.
 */
import { log } from './logger.js';

const powerLog = (function() {
    const sessionStart = Date.now();

    const counters = {
        /** setInterval ticks, keyed by loop id from utils/powerPolicy.js */
        wakeups: {},
        /** API calls, keyed by a coarse endpoint class */
        requests: {},
        /** loop start/stop transitions driven by the power plan */
        loopStarts: 0,
        loopStops: 0,
        /** how many times the page went hidden */
        hides: 0
    };

    // Accumulated durations (ms) plus the open interval's start, or null.
    const spans = {
        visible: { total: 0, since: null },
        wakeLock: { total: 0, since: null },
        mic: { total: 0, since: null },
        inGame: { total: 0, since: null }
    };

    /** @type {Array<{t: number, level: number, charging: boolean, note: string}>} */
    const batterySamples = [];
    let batteryManager = null;

    function openSpan(name) {
        const s = spans[name];
        if (s && s.since === null) s.since = Date.now();
    }

    function closeSpan(name) {
        const s = spans[name];
        if (!s || s.since === null) return;
        s.total += Date.now() - s.since;
        s.since = null;
    }

    function spanMs(name) {
        const s = spans[name];
        if (!s) return 0;
        return s.total + (s.since === null ? 0 : Date.now() - s.since);
    }

    /**
     * Count one timer tick. Called from inside a loop's callback, so the count
     * reflects ticks that actually ran rather than ticks we intended — which
     * is the point, since browser throttling silently drops the difference.
     * @param {string} loop - a utils/powerPolicy.js LOOPS value
     */
    function countWakeup(loop) {
        counters.wakeups[loop] = (counters.wakeups[loop] || 0) + 1;
    }

    /**
     * Count one network request against a coarse class (e.g. 'controller',
     * 'game', 'teams'). Finer than that and the log becomes unreadable.
     * @param {string} kind
     */
    function countRequest(kind) {
        counters.requests[kind] = (counters.requests[kind] || 0) + 1;
    }

    /**
     * Take a battery reading where the platform offers one. No-ops on iOS and
     * Firefox. `note` labels what prompted the sample ('session-start',
     * 'point-end', 'game-end') so deltas can be read off later.
     * @param {string} note
     */
    async function sampleBattery(note) {
        if (typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function') return;
        try {
            if (!batteryManager) batteryManager = await navigator.getBattery();
            batterySamples.push({
                t: Date.now(),
                level: batteryManager.level,
                charging: batteryManager.charging,
                note: String(note || '')
            });
        } catch (_) {
            // Permissions-Policy can block it even where it exists.
        }
    }

    /** Whether real battery readings are available on this device. */
    function hasBatteryApi() {
        return typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function';
    }

    /**
     * The whole session as a plain object — the thing the Online/About overlay
     * renders and the copy button serializes.
     */
    function snapshot() {
        const elapsedMs = Date.now() - sessionStart;
        const first = batterySamples[0];
        const last = batterySamples[batterySamples.length - 1];

        return {
            elapsedMs,
            visibleMs: spanMs('visible'),
            inGameMs: spanMs('inGame'),
            wakeLockMs: spanMs('wakeLock'),
            micMs: spanMs('mic'),
            hides: counters.hides,
            loopStarts: counters.loopStarts,
            loopStops: counters.loopStops,
            wakeups: { ...counters.wakeups },
            requests: { ...counters.requests },
            totalWakeups: Object.values(counters.wakeups).reduce((a, b) => a + b, 0),
            totalRequests: Object.values(counters.requests).reduce((a, b) => a + b, 0),
            battery: {
                supported: hasBatteryApi(),
                samples: batterySamples.length,
                // Positive = percentage points consumed over the session.
                drainPct: (first && last && first !== last)
                    ? Math.round((first.level - last.level) * 1000) / 10
                    : null,
                firstLevelPct: first ? Math.round(first.level * 100) : null,
                lastLevelPct: last ? Math.round(last.level * 100) : null,
                charging: last ? last.charging : null
            }
        };
    }

    function fmtDuration(ms) {
        const totalSec = Math.round(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return h > 0 ? `${h}h ${m}m` : (m > 0 ? `${m}m ${s}s` : `${s}s`);
    }

    /** Human-readable report for the Online/About overlay and field reports. */
    function formatReport() {
        const snap = snapshot();
        const lines = [];

        lines.push(`Session: ${fmtDuration(snap.elapsedMs)} ` +
                   `(on screen ${fmtDuration(snap.visibleMs)}, in game ${fmtDuration(snap.inGameMs)})`);
        lines.push(`Backgrounded ${snap.hides}×`);
        lines.push(`Screen kept awake: ${fmtDuration(snap.wakeLockMs)}`);
        if (snap.micMs > 0) lines.push(`Mic open: ${fmtDuration(snap.micMs)}`);

        const perHour = snap.elapsedMs > 0
            ? Math.round(snap.totalWakeups / (snap.elapsedMs / 3600000))
            : 0;
        lines.push(`Timer wakeups: ${snap.totalWakeups} (~${perHour}/hr)`);
        Object.entries(snap.wakeups)
            .sort((a, b) => b[1] - a[1])
            .forEach(([loop, n]) => lines.push(`  ${loop}: ${n}`));

        lines.push(`API requests: ${snap.totalRequests}`);
        Object.entries(snap.requests)
            .sort((a, b) => b[1] - a[1])
            .forEach(([kind, n]) => lines.push(`  ${kind}: ${n}`));

        if (!snap.battery.supported) {
            // Say why, so a field report from an iPhone isn't read as a bug.
            lines.push('Battery readings: not available on this browser (iOS/Safari and Firefox have no Battery Status API)');
        } else if (snap.battery.drainPct === null) {
            lines.push(`Battery: ${snap.battery.lastLevelPct}% — not enough samples yet`);
        } else {
            lines.push(`Battery: ${snap.battery.firstLevelPct}% → ${snap.battery.lastLevelPct}% ` +
                       `(${snap.battery.drainPct > 0 ? '-' : '+'}${Math.abs(snap.battery.drainPct)} pts` +
                       `${snap.battery.charging ? ', charging' : ''})`);
        }

        return lines.join('\n');
    }

    // ─── Wiring ─────────────────────────────────────────────────────────────

    if (typeof document !== 'undefined') {
        if (document.visibilityState !== 'hidden') openSpan('visible');

        document.addEventListener('breakside:power-plan', (e) => {
            const d = e.detail;
            if (!d) return;
            counters.loopStarts += (d.start?.length || 0);
            counters.loopStops += (d.stop?.length || 0);

            if (d.ctx?.visible) {
                openSpan('visible');
            } else {
                if (spans.visible.since !== null) counters.hides++;
                closeSpan('visible');
            }

            if (d.ctx?.inGame) openSpan('inGame');
            else closeSpan('inGame');
        });

        document.addEventListener('breakside:wake-lock-changed', (e) => {
            if (e.detail?.held) openSpan('wakeLock');
            else closeSpan('wakeLock');
        });
    }

    /** Mic span control — called by the narration session on start/stop. */
    function micOpened() { openSpan('mic'); }
    function micClosed() { closeSpan('mic'); }

    // A first reading as early as possible, so a session that runs to game end
    // has two ends of a delta to report.
    sampleBattery('session-start');

    log('🔋 Power log started');

    return {
        countWakeup, countRequest, sampleBattery, hasBatteryApi,
        micOpened, micClosed, snapshot, formatReport
    };
})();

// --- ES-module export ---
export { powerLog };
// window survivor: late-bound state accessor (read window-qualified by
// store/sync.js and narration/realtimeSession.js, which sit at or below this
// module's layer and cannot import upward)
window.powerLog = powerLog;
