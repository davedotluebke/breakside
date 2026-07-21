/*
 * Cached microphone stream — iOS permission-prompt mitigation.
 *
 * iOS/WebKit does not persist getUserMedia grants: once every track of a
 * capture stream has been stopped, the next getUserMedia re-prompts unless it
 * lands inside WebKit's short just-released grace window. With the old
 * stop-and-reacquire flow, rapid consecutive narrations sailed through that
 * window but any short pause put the permission modal in front of the coach
 * again before every utterance.
 *
 * Fix: this module owns THE mic stream. Sessions acquire() it and idle() it
 * back instead of stopping tracks. The stream stays live ("warm") between
 * recordings — nothing reads audio while idle (no source node is connected),
 * but iOS keeps the grant, so the next acquire() reuses the stream without a
 * prompt. After holdMs of idleness the stream is released for privacy and
 * battery (the OS mic indicator is on the whole time it's warm); the next
 * acquire() after that re-prompts once.
 *
 * Backgrounding: iOS mutes (not ends) live tracks on app switch or screen
 * lock and revives them on return, so a warm stream survives brief absences.
 * When iOS does kill a track (long background, mic taken by a phone call),
 * the onended handler drops the cache so acquire() starts fresh instead of
 * reusing a corpse.
 *
 * Leaf module by design — no imports, so it loads under node for unit tests
 * (tests/unit/micStream.test.mjs). Callers pass holdMs in; the Advanced
 * Settings read lives with the caller (realtimeSession.js).
 */
const micStream = (function() {
    let stream = null;           // cached MediaStream (null = cold)
    let constraintsKey = null;   // JSON of the constraints it was acquired with
    let inUse = false;           // a session is actively capturing from it
    let idleTimer = null;
    let getUserMediaImpl = null; // test seam; defaults to navigator.mediaDevices

    function clearIdleTimer() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    function hasLiveTrack() {
        return !!stream && stream.getTracks().some(t => t.readyState === 'live');
    }

    /**
     * Get the mic stream, reusing the warm cached one when it's live and was
     * acquired with the same constraints. A constraints mismatch (the user
     * changed audio processing in Advanced Settings) forces a fresh
     * getUserMedia so the new constraints actually apply.
     * @param {object} audioConstraints - getUserMedia audio constraints
     * @returns {Promise<MediaStream>}
     */
    async function acquire(audioConstraints) {
        clearIdleTimer();
        const key = JSON.stringify(audioConstraints || null);
        if (hasLiveTrack() && key === constraintsKey) {
            inUse = true;
            return stream;
        }
        release();  // drop a dead or constraint-mismatched stream
        const gum = getUserMediaImpl
            || ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
        const s = await gum({ audio: audioConstraints });
        stream = s;
        constraintsKey = key;
        inUse = true;
        s.getTracks().forEach(t => {
            t.onended = () => { if (stream === s) release(); };
        });
        return s;
    }

    /**
     * Mark the stream no longer in use. Holds it warm for holdMs, then
     * releases it; holdMs <= 0 releases immediately (the old always-release
     * behavior, selectable in Advanced Settings).
     * @param {number} holdMs
     */
    function idle(holdMs) {
        inUse = false;
        clearIdleTimer();
        if (!stream) return;
        if (!(holdMs > 0)) {
            release();
            return;
        }
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (!inUse) release();
        }, holdMs);
    }

    /** Stop all tracks and forget the stream (the next acquire re-prompts). */
    function release() {
        clearIdleTimer();
        if (stream) {
            stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        }
        stream = null;
        constraintsKey = null;
        inUse = false;
    }

    /**
     * Release unless a session is actively capturing. The game-exit hook:
     * leaving the game shouldn't keep the mic indicator on, but must never
     * yank tracks out from under a live recording — the idle timeout collects
     * those later.
     */
    function releaseIfIdle() {
        if (!inUse) release();
    }

    /** Is a warm-or-active stream currently held? (debug/tests) */
    function isHeld() {
        return hasLiveTrack();
    }

    function _setGetUserMediaForTests(fn) {
        getUserMediaImpl = fn;
    }

    return { acquire, idle, release, releaseIfIdle, isHeld, _setGetUserMediaForTests };
})();

// --- ES-module export ---
export { micStream };
