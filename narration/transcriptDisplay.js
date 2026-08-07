/*
 * Live Transcript Display
 *
 * A small floating panel that sits just above the mic button and shows the
 * live transcript as the coach narrates. Subscribes to the eventBus
 * `transcriptUpdated` channel.
 *
 * Visibility lifecycle:
 *   - Hidden when not recording
 *   - Fades in when recording starts (we listen for the first transcript
 *     update OR for a short visibility-poke published by the engine)
 *   - Stays visible during recording, scrolling to keep latest text in view
 *   - Stays visible briefly after stop (during the slow-pass finalize) so
 *     the coach can read what was heard while events get extracted
 *   - Fades out once finalize completes and idle phase resumes
 *
 * The display is read-only and does not affect game state. It exists so
 * the coach can see they're being heard — important confidence-builder
 * since structured events now only appear after stop (transcription-only
 * fast pass).
 *
 * Builds the panel and subscribes to the bus. Exposes a single late-bound
 * hook, window.narrationTranscriptDisplay.refreshPhase(), which the engine
 * calls on each phase transition — this replaced a 200ms phase poll that ran
 * for the lifetime of the tab.
 */
import { narrationEventBus } from './eventBus.js';
import { narrationEngine } from './narrationEngine.js';

(function() {
    const PANEL_ID = 'narrationTranscriptPanel';
    // Maximum characters to keep in view; we truncate the head so the most
    // recent text stays in the panel even on long narrations.
    const MAX_CHARS = 600;
    // How long after recording stops to keep the panel visible (ms). Gives
    // the coach time to read the final transcript while finalize runs.
    const POST_STOP_LINGER_MS = 5000;

    let panel = null;
    let textEl = null;
    let labelEl = null;
    let lastTranscript = '';
    let hideTimer = null;

    function ensurePanel() {
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'narration-transcript-panel';

        labelEl = document.createElement('div');
        labelEl.className = 'narration-transcript-label';
        labelEl.textContent = 'Listening…';

        textEl = document.createElement('div');
        textEl.className = 'narration-transcript-text';

        panel.appendChild(labelEl);
        panel.appendChild(textEl);
        document.body.appendChild(panel);
        return panel;
    }

    function show() {
        ensurePanel();
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        panel.classList.add('visible');
    }

    function hide() {
        if (!panel) return;
        panel.classList.remove('visible');
    }

    function reset() {
        lastTranscript = '';
        if (textEl) textEl.textContent = '';
        if (labelEl) labelEl.textContent = 'Listening…';
    }

    function setText(t) {
        ensurePanel();
        lastTranscript = t || '';
        // Truncate from the head if the text is very long, keeping the tail.
        const display = lastTranscript.length > MAX_CHARS
            ? '…' + lastTranscript.slice(-MAX_CHARS)
            : lastTranscript;
        textEl.textContent = display;
        // Scroll to bottom (just in case the panel has a fixed height and
        // overflow scroll).
        textEl.scrollTop = textEl.scrollHeight;
    }

    /**
     * Sync the panel to the engine's phase: show/hide, and update the label.
     *
     * Called on every phase transition (narrationEngine.setPhase invokes
     * window.narrationTranscriptDisplay.refreshPhase). This used to be a
     * 200ms poll that ran for the entire lifetime of the tab — five wakeups a
     * second, forever, whether or not narration had ever been used.
     */
    function refreshPhase() {
        if (!narrationEngine || !narrationEngine.getPhase) return;
        const phase = narrationEngine.getPhase();
        if (!labelEl) return;
        if (phase === 'connecting') {
            labelEl.textContent = 'Connecting…';
            show();
        } else if (phase === 'recording') {
            labelEl.textContent = 'Listening…';
            show();
        } else if (phase === 'finalizing') {
            labelEl.textContent = 'Processing…';
            show();
        } else {
            // idle — schedule hide after lingering briefly. If recording
            // restarts in that window the show() call clears the timer.
            if (panel && panel.classList.contains('visible') && !hideTimer) {
                hideTimer = setTimeout(() => {
                    hide();
                    reset();
                    hideTimer = null;
                }, POST_STOP_LINGER_MS);
            }
        }
    }

    function init() {
        ensurePanel();

        if (narrationEventBus) {
            narrationEventBus.subscribe('transcriptUpdated', (payload) => {
                if (payload && typeof payload.full === 'string') {
                    setText(payload.full);
                }
            });
        }

        // Reflect whatever phase the engine is already in, in case a
        // transition happened before this module finished initializing.
        refreshPhase();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // window survivor: late-bound back-edge hook (called window-qualified by
    // narration/narrationEngine.js setPhase — the same cycle that keeps
    // window.narrationMicButton window-qualified applies here: an
    // engine↔display import would invert their eval order)
    window.narrationTranscriptDisplay = { refreshPhase };
})();
