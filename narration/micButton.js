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
 * window.narrationEngine.startRecording() / stopRecording().
 */

(function() {
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
        return !!(window.narrationEngine && window.narrationEngine.isRecording && window.narrationEngine.isRecording());
    }

    /**
     * Whether narration is available at all (engine loaded + browser supports
     * microphone). We show the button even when disabled so the user knows it
     * exists; they just can't tap it.
     */
    function isNarrationAvailable() {
        if (!window.narrationEngine) return false;
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
        const phase = window.narrationEngine && window.narrationEngine.getPhase
            ? window.narrationEngine.getPhase()
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
        if (!isRecording()) {
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
            // Temporary recording mode: stop on release.
            if (isRecording()) {
                stopRecording();
            }
        } else {
            // Short tap: toggle.
            if (pressDuration < LONG_PRESS_MS) {
                if (isRecording()) {
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
        // If the long-press already fired (we started recording), treat this
        // cancellation as a release so we don't leave the mic hot.
        if (pressWasLongPress && isRecording()) {
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
        window.narrationEngine.startRecording()
            .then(() => refreshButtonState())
            .catch(err => {
                console.error('[micButton] startRecording failed:', err);
                refreshButtonState();
                if (typeof showControllerToast === 'function') {
                    showControllerToast('Microphone unavailable: ' + (err.message || err), 'error');
                }
            });
    }

    function stopRecording() {
        if (!window.narrationEngine) return;
        window.narrationEngine.stopRecording()
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

        // Listen on the event bus for phase changes (engine tells us when
        // connecting/recording/finalizing changes) so we can update promptly.
        if (window.narrationEventBus) {
            // We don't have a dedicated channel for phase; the engine calls
            // window.narrationMicButton.refresh() directly. Expose it.
        }

        // Expose a refresh hook for the engine to call on phase transitions.
        window.narrationMicButton = {
            refresh: refreshButtonState,
            refreshVisibility: refreshVisibility
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
