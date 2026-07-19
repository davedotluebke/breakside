/*
 * Narration Mic Button
 *
 * Floating FAB at bottom-center that controls speech narration recording.
 *
 * Interaction model:
 *   - Short tap (press+release < LONG_PRESS_MS): toggle recording on/off
 *   - Long press (held >= LONG_PRESS_MS):        temporary recording — records
 *                                                until finger lifts, then stops
 *
 * Visibility: shown only when the in-game screen is active. Uses polling
 * against isGameScreenVisible() since the existing enter/exit functions do
 * not emit events.
 *
 * This module does not know anything about audio or LLMs — it delegates to
 * narrationEngine.startRecording() / stopRecording().
 */
import { isGameScreenVisible } from '../ui/panelSystem.js';
import { showControllerToast } from '../game/controllerState.js';
import { narrationEngine } from './narrationEngine.js';

const narrationMicButton = (function() {
    const BTN_ID = 'narrationMicBtn';
    const LONG_PRESS_MS = 400;
    const VISIBILITY_POLL_MS = 500;

    // State
    let btn = null;
    let pressStartTime = 0;
    let pressTimerId = null;
    let pressWasLongPress = false;
    let isPressed = false;

    /**
     * Current recording state, queried from the narration engine.
     * Falls back to false if the engine isn't loaded yet.
     */
    function isRecording() {
        return !!(narrationEngine && narrationEngine.isRecording && narrationEngine.isRecording());
    }

    /** Current engine phase ('idle'|'connecting'|'recording'|'finalizing'), or null. */
    function currentPhase() {
        return (narrationEngine && narrationEngine.getPhase)
            ? narrationEngine.getPhase()
            : null;
    }

    /**
     * Whether the session is live OR mid-handshake. Releasing/cancelling during
     * 'connecting' must still stop, otherwise the connect completes after the
     * user lifted and the mic is left hot with no UI affordance to stop it.
     */
    function isRecordingOrConnecting() {
        return isRecording() || currentPhase() === 'connecting';
    }

    /**
     * Whether narration is available at all (engine loaded + browser supports
     * microphone). We show the button even when disabled so the user knows it
     * exists; they just can't tap it.
     */
    function isNarrationAvailable() {
        if (!narrationEngine) return false;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
        return true;
    }

    /**
     * Update the button's visual state to match the current recording /
     * availability state. Does not change visibility (show/hide).
     */
    function refreshButtonState() {
        if (!btn) return;
        btn.classList.remove('mic-idle', 'mic-recording', 'mic-connecting', 'mic-disabled', 'mic-finalizing');

        // Check if engine reports a transient connecting/finalizing phase
        const phase = narrationEngine && narrationEngine.getPhase
            ? narrationEngine.getPhase()
            : null;

        if (!isNarrationAvailable()) {
            btn.classList.add('mic-disabled');
            btn.title = 'Narration unavailable (no microphone support)';
            btn.setAttribute('aria-label', 'Narration unavailable');
            return;
        }

        if (phase === 'connecting') {
            btn.classList.add('mic-connecting');
            btn.title = 'Connecting…';
            btn.setAttribute('aria-label', 'Connecting');
        } else if (phase === 'finalizing') {
            btn.classList.add('mic-finalizing');
            btn.title = 'Finalizing narration…';
            btn.setAttribute('aria-label', 'Finalizing');
        } else if (isRecording()) {
            btn.classList.add('mic-recording');
            btn.title = 'Recording — tap to stop';
            btn.setAttribute('aria-label', 'Stop recording');
        } else {
            btn.classList.add('mic-idle');
            btn.title = 'Tap to start recording, or hold to record while held';
            btn.setAttribute('aria-label', 'Start recording');
        }
    }

    /**
     * Show or hide the button based on whether the game screen is visible.
     */
    function refreshVisibility() {
        if (!btn) return;
        const visible = typeof isGameScreenVisible === 'function' && isGameScreenVisible();
        btn.classList.toggle('visible', !!visible);
    }

    // ---------------------------------------------------------------------
    // Press handling
    // ---------------------------------------------------------------------

    /**
     * Long-press fired: engage temporary recording mode (record while held).
     * We set a flag so the subsequent release will stop recording rather than
     * toggle it (since it's already on).
     */
    function onLongPressFired() {
        pressWasLongPress = true;
        if (!isRecordingOrConnecting()) {
            startRecording();
        }
    }

    function onPressStart(ev) {
        if (ev.cancelable) ev.preventDefault();
        if (isPressed) return;  // Ignore duplicate events (mouse+touch)
        isPressed = true;
        pressStartTime = Date.now();
        pressWasLongPress = false;

        pressTimerId = setTimeout(onLongPressFired, LONG_PRESS_MS);
    }

    function onPressEnd(ev) {
        if (!isPressed) return;
        if (ev && ev.cancelable) ev.preventDefault();
        isPressed = false;

        if (pressTimerId) {
            clearTimeout(pressTimerId);
            pressTimerId = null;
        }

        const pressDuration = Date.now() - pressStartTime;

        if (pressWasLongPress) {
            // Temporary recording mode: stop on release (even if we're still
            // connecting — stopRecording aborts an in-flight connect).
            if (isRecordingOrConnecting()) {
                stopRecording();
            }
        } else {
            // Short tap: toggle. While connecting/recording, a tap stops.
            if (pressDuration < LONG_PRESS_MS) {
                if (isRecordingOrConnecting()) {
                    stopRecording();
                } else {
                    startRecording();
                }
            }
        }
    }

    function onPressCancel() {
        if (!isPressed) return;
        isPressed = false;
        if (pressTimerId) {
            clearTimeout(pressTimerId);
            pressTimerId = null;
        }
        // If the long-press already fired (we started recording, or are still
        // connecting), treat this cancellation as a release so we don't leave
        // the mic hot — stopRecording aborts an in-flight connect.
        if (pressWasLongPress && isRecordingOrConnecting()) {
            stopRecording();
        }
    }

    // ---------------------------------------------------------------------
    // Recording actions — delegate to the narration engine
    // ---------------------------------------------------------------------

    function startRecording() {
        if (!isNarrationAvailable()) {
            console.warn('[micButton] Narration engine not available');
            return;
        }
        refreshButtonState();  // Show connecting state immediately
        narrationEngine.startRecording()
            .then(() => refreshButtonState())
            .catch(err => {
                console.error('[micButton] startRecording failed:', err);
                refreshButtonState();
                if (typeof showControllerToast === 'function') {
                    // Not always a mic problem — the realtime socket can die
                    // during setup too (G5). Keep the message cause-neutral.
                    showControllerToast('Narration failed to start: ' + (err.message || err), 'error');
                }
            });
    }

    function stopRecording() {
        if (!narrationEngine) return;
        narrationEngine.stopRecording()
            .then(() => refreshButtonState())
            .catch(err => {
                console.error('[micButton] stopRecording failed:', err);
                refreshButtonState();
            });
        refreshButtonState();
    }

    // ---------------------------------------------------------------------
    // Initialization
    // ---------------------------------------------------------------------

    function createButton() {
        if (document.getElementById(BTN_ID)) return document.getElementById(BTN_ID);
        const b = document.createElement('button');
        b.id = BTN_ID;
        b.type = 'button';
        b.className = 'mic-idle';
        b.innerHTML = '<i class="fas fa-microphone"></i>';

        // Prevent context menu on long press (iOS/Android)
        b.addEventListener('contextmenu', (e) => e.preventDefault());

        // Touch events (mobile)
        b.addEventListener('touchstart', onPressStart, { passive: false });
        b.addEventListener('touchend', onPressEnd);
        b.addEventListener('touchcancel', onPressCancel);

        // Mouse events (desktop) — only if no touch is in progress
        b.addEventListener('mousedown', (e) => {
            // Primary button only
            if (e.button !== 0) return;
            onPressStart(e);
        });
        b.addEventListener('mouseup', onPressEnd);
        b.addEventListener('mouseleave', onPressCancel);

        document.body.appendChild(b);
        return b;
    }

    function init() {
        btn = createButton();
        refreshVisibility();
        refreshButtonState();

        // Poll visibility since enterGameScreen/exitGameScreen don't emit events.
        setInterval(refreshVisibility, VISIBILITY_POLL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Public API: the refresh hook the engine calls on phase transitions.
    // (There's no dedicated bus channel for phase; the engine invokes
    // window.narrationMicButton.refresh() directly.)
    return {
        refresh: refreshButtonState,
        refreshVisibility: refreshVisibility
    };
})();

// --- ES-module export ---
export { narrationMicButton };
// window survivor: late-bound back-edge hook (called window-qualified by
// narration/narrationEngine.js setPhase — an engine↔micButton import cycle
// would invert their eval order; see setPhase)
window.narrationMicButton = narrationMicButton;
