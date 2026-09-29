/*
 * Narration Mic Button
 *
 * Floating FAB at bottom-right that controls speech narration recording.
 *
 * One button, two jobs. Which one it drives follows the game clock, not the
 * tab (see isLineupContext):
 *   - between points → lineup narration ("Kris in for Wes"), on ANY tab
 *   - during a point → event narration, except on the Line tab
 * The press handlers never branch on which one is live.
 *
 * Where the button appears is a per-device setting (Advanced Settings →
 * Audio Narration → Mic button; 'narration.mode' in settings/advancedSettings.js):
 *   - 'all'     every game tab, both jobs (the default)
 *   - 'lineup'  the Line and All tabs only, and only ever lineup narration —
 *               a coach who wants the mic just for calling lines shouldn't
 *               have a hot mic within thumb reach on the play tabs
 *   - 'off'     no button at all: one less thing to mis-tap
 * A running recording (or its follow-up work) keeps the button on screen
 * whatever the setting or tab says, so it can always be stopped.
 *
 * Interaction model:
 *   - Short tap (press+release < LONG_PRESS_MS): toggle recording on/off
 *   - Long press (held >= LONG_PRESS_MS):        temporary recording — records
 *                                                until finger lifts, then stops
 *
 * Visibility: shown only when the in-game screen is active and the setting
 * allows it on the current tab. Game-screen enter/exit, tab changes
 * (ui/panelSystem.js applyTabState), phase transitions in either narration
 * layer, and the setting itself all call back into render(); nothing polls.
 * Correctness never rides on the paint either way: every press reads
 * currentTarget() live.
 *
 * This module does not know anything about audio or LLMs — it delegates to
 * the target's start()/stop().
 */
import { isGameScreenVisible, getActiveTab } from '../ui/panelSystem.js';
import { showControllerToast } from '../game/controllerState.js';
import { isPointInProgress } from '../utils/helpers.js';
import { advancedSettings } from '../settings/advancedSettings.js';
import { narrationEngine } from './narrationEngine.js';
import { lineupNarration } from './lineupNarration.js';

const narrationMicButton = (function() {
    const BTN_ID = 'narrationMicBtn';
    const LONG_PRESS_MS = 400;

    // Phase → button class. Lineup's post-release work is called 'processing'
    // and the engine's is called 'finalizing'; both mean "mic is cold, work is
    // still running", so they share the blue pulse.
    const PHASE_CLASS = {
        connecting: 'mic-connecting',
        recording:  'mic-recording',
        finalizing: 'mic-finalizing',
        processing: 'mic-finalizing',
        idle:       'mic-idle'
    };
    const ALL_PHASE_CLASSES = ['mic-idle', 'mic-recording', 'mic-connecting', 'mic-disabled', 'mic-finalizing'];

    // ---------------------------------------------------------------------
    // Narration targets
    //
    // Each target wraps one narration subsystem behind the same surface:
    //   phase()          current phase string (keys of PHASE_CLASS)
    //   isBusy()         mic is hot or mid-handshake — a tap/release stops it
    //   blocked(phase)   message to toast instead of starting, or null
    //   start() / stop() promises
    //   ui[phase]        [title, aria-label]
    // ---------------------------------------------------------------------

    const eventTarget = {
        name: 'event',
        phase: () => (narrationEngine && narrationEngine.getPhase)
            ? narrationEngine.getPhase()
            : 'idle',
        // Kept as the engine's own recording flag rather than phase ===
        // 'recording' so this stays byte-for-byte the pre-merge predicate.
        isBusy() {
            const recording = !!(narrationEngine && narrationEngine.isRecording && narrationEngine.isRecording());
            return recording || this.phase() === 'connecting';
        },
        // Tapping during 'finalizing' starts the next recording, as before —
        // the mic is already cold by then and coaches machine-gun events.
        blocked: () => null,
        start: () => narrationEngine.startRecording(),
        stop: () => narrationEngine.stopRecording(),
        failedToStart: (msg) => 'Narration failed to start: ' + msg,
        ui: {
            idle:       ['Tap to start recording, or hold to record while held', 'Start recording'],
            connecting: ['Connecting…', 'Connecting'],
            recording:  ['Recording — tap to stop', 'Stop recording'],
            finalizing: ['Finalizing narration…', 'Finalizing']
        }
    };

    const lineupTarget = {
        name: 'lineup',
        phase: () => (lineupNarration && lineupNarration.getPhase)
            ? lineupNarration.getPhase()
            : 'idle',
        isBusy() {
            const p = this.phase();
            return p === 'recording' || p === 'connecting';
        },
        // A tap while the previous line is still resolving must not silently
        // no-op — start() returns early and the coach reads that as a dead mic.
        blocked: (phase) => phase === 'processing'
            ? 'Still working out the previous lineup…'
            : null,
        start: () => lineupNarration.start(),
        stop: () => lineupNarration.stop(),
        failedToStart: (msg) => 'Lineup narration failed to start: ' + msg,
        ui: {
            idle:       ['Narrate the next line — tap, speak names or subs, tap again', 'Narrate lineup'],
            connecting: ['Connecting…', 'Connecting'],
            recording:  ['Listening — tap to finish the lineup', 'Finish lineup'],
            processing: ['Working out the lineup…', 'Working out the lineup']
        }
    };

    /**
     * Whether the mic should be talking about a LINE rather than about play.
     *
     * Between points that's true on every tab — a solo coach shouldn't have
     * to detour to the Line tab to call the next line, and it's the only
     * thing there is to narrate with no point running. During a point the
     * Line tab still counts: a coach sitting there is planning the next
     * line, not watching the disc.
     *
     * (Phase two hangs "start point" off the same between-points window.)
     */
    function isLineupContext() {
        if (typeof isPointInProgress === 'function' && !isPointInProgress()) return true;
        return (typeof getActiveTab === 'function' ? getActiveTab() : null) === 'line';
    }

    /**
     * The per-device setting: 'all' | 'lineup' | 'off'. Read live on every
     * render and every press, so a change in Advanced Settings mid-game
     * takes effect at once.
     */
    function narrationMode() {
        return (advancedSettings && advancedSettings.getNarrationMode)
            ? advancedSettings.getNarrationMode()
            : 'all';
    }

    // Tabs the button stays on in 'lineup' mode: Line is where a line gets
    // called, and All shows the same Select Line panel beside play-by-play.
    const LINEUP_ONLY_TABS = ['line', 'all'];

    /**
     * Whether the setting allows the button on the current tab. A busy
     * target overrides this (see render): whatever the coach just changed,
     * they must be able to stop what is running.
     */
    function isEnabledOnTab() {
        const mode = narrationMode();
        if (mode === 'off') return false;
        if (mode === 'lineup') {
            const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
            return LINEUP_ONLY_TABS.includes(tab);
        }
        return true;
    }

    function anyTargetBusy() {
        return lineupTarget.phase() !== 'idle' || eventTarget.phase() !== 'idle';
    }

    /**
     * Which target the button drives right now.
     *
     * A non-idle target always wins over the context: the game clock and the
     * tab can both move mid-session, and the button must keep offering "stop"
     * for the work that is actually running rather than starting a second one
     * (both share the realtime-session singleton, so the second would fail
     * anyway). In particular this keeps a lineup recording stoppable through
     * the point start that would otherwise flip the context under it.
     *
     * In 'lineup' mode the button never drives event narration, even
     * mid-point on the All tab — that is the whole point of the setting.
     */
    function currentTarget() {
        if (lineupTarget.phase() !== 'idle') return lineupTarget;
        if (eventTarget.phase() !== 'idle') return eventTarget;
        if (narrationMode() === 'lineup') return lineupTarget;
        return isLineupContext() ? lineupTarget : eventTarget;
    }

    // State
    let btn = null;
    let pressStartTime = 0;
    let pressTimerId = null;
    let pressWasLongPress = false;
    let isPressed = false;
    // Target captured at press-start and held for the whole press, so a phase
    // transition mid-press can't route the release to the other subsystem.
    let pressTarget = null;

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
     * Paint the button: shown or hidden, then colour and tooltip for the
     * current target's phase. The one entry point for every "something
     * changed" signal — game-screen enter/exit, tab change, phase
     * transition, setting change — so none of them can disagree about what
     * is on screen. Cheap enough (a few class flips) to run unconditionally.
     */
    function render() {
        if (!btn) return;
        const inGame = typeof isGameScreenVisible === 'function' && isGameScreenVisible();
        // The setting (and, for lineups only, the tab) decides — unless a
        // recording or its follow-up work is running, in which case the
        // button stays until that is idle: the coach must be able to stop
        // what they started, and see it finish, whatever they just changed.
        const visible = !!inGame && (isEnabledOnTab() || anyTargetBusy());
        btn.classList.toggle('visible', visible);
        // Mirrored on <body> for the layouts that keep the button's corner
        // clear — the Field events bar's right padding, the Full tab's log
        // strip, the Line tab's table bottom, the Field tab's mic
        // placeholder (playByPlay/fieldPbp.css, fullPbp.css,
        // ui/panelSystem.css). Gated on this class, that room exists only
        // while the button does, so turning the mic off (or limiting it to
        // lineups) gives the space back on the tabs it left.
        document.body.classList.toggle('mic-button-visible', visible);

        btn.classList.remove(...ALL_PHASE_CLASSES);
        if (!isNarrationAvailable()) {
            btn.classList.add('mic-disabled');
            btn.title = 'Narration unavailable (no microphone support)';
            btn.setAttribute('aria-label', 'Narration unavailable');
            return;
        }

        const target = currentTarget();
        const phase = target.phase();
        const [title, label] = target.ui[phase] || target.ui.idle;

        btn.classList.add(PHASE_CLASS[phase] || 'mic-idle');
        btn.title = title;
        btn.setAttribute('aria-label', label);
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
        if (!pressTarget.isBusy()) {
            startRecording(pressTarget);
        }
    }

    function onPressStart(ev) {
        if (ev.cancelable) ev.preventDefault();
        if (isPressed) return;  // Ignore duplicate events (mouse+touch)
        isPressed = true;
        pressStartTime = Date.now();
        pressWasLongPress = false;
        pressTarget = currentTarget();

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
        const target = pressTarget;
        pressTarget = null;

        if (pressWasLongPress) {
            // Temporary recording mode: stop on release (even if we're still
            // connecting — stop() aborts an in-flight connect).
            if (target.isBusy()) {
                stopRecording(target);
            }
        } else {
            // Short tap: toggle. While connecting/recording, a tap stops.
            if (pressDuration < LONG_PRESS_MS) {
                if (target.isBusy()) {
                    stopRecording(target);
                } else {
                    startRecording(target);
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
        const target = pressTarget;
        pressTarget = null;
        // If the long-press already fired (we started recording, or are still
        // connecting), treat this cancellation as a release so we don't leave
        // the mic hot — stop() aborts an in-flight connect.
        if (pressWasLongPress && target && target.isBusy()) {
            stopRecording(target);
        }
    }

    // ---------------------------------------------------------------------
    // First-use disclosure
    //
    // Narration streams live mic audio to OpenAI and hands the transcript to
    // Anthropic, and neither of those is guessable from a mic icon. Shown once
    // per device, before the first session of either kind, and remembered in
    // localStorage. Markup: #narrationDisclosureModal in index.html.
    // ---------------------------------------------------------------------

    const DISCLOSURE_ACK_PREFIX = 'breakside_narration_disclosure_ack';
    const DISCLOSURE_MODAL_ID = 'narrationDisclosureModal';

    // Set while the modal is open so Enable can resume the press that opened
    // it. Cleared by either button.
    let disclosureOnAccept = null;

    // Keyed per user, not per device. A club tablet passes between coaches —
    // the same reason the sign-out backup is bounded (auth/signOutBackup.js) —
    // and one coach's consent is not another's. Signed-out narration falls back
    // to a shared key rather than asking on every tap.
    function disclosureAckKey() {
        let userId = null;
        try {
            userId = window.breakside?.auth?.getCurrentUser?.()?.id || null;
        } catch (_) { /* auth not initialized yet */ }
        return userId ? `${DISCLOSURE_ACK_PREFIX}:${userId}` : DISCLOSURE_ACK_PREFIX;
    }

    function hasAcknowledgedDisclosure() {
        try {
            return localStorage.getItem(disclosureAckKey()) === 'true';
        } catch (_) {
            // Storage unavailable (Safari private browsing). Show it every
            // time rather than skip it — repetitive beats undisclosed.
            return false;
        }
    }

    function closeDisclosure() {
        const modal = document.getElementById(DISCLOSURE_MODAL_ID);
        if (modal) modal.style.display = 'none';
        disclosureOnAccept = null;
    }

    // Plain-text twin of the modal copy in index.html, for the confirm()
    // fallback below. Keep the two in step.
    const DISCLOSURE_FALLBACK_TEXT =
        'Voice narration sends live audio from your microphone to OpenAI, and '
        + 'the transcript plus your roster to Anthropic, to turn what you say '
        + 'into game events.\n\n'
        + 'Anyone near the microphone may be recorded. Do not use it where you '
        + 'would be uncomfortable recording.\n\n'
        + 'See the privacy notice at /privacy.html for details.\n\n'
        + 'Enable voice narration?';

    function showDisclosure(onAccept) {
        const modal = document.getElementById(DISCLOSURE_MODAL_ID);
        if (!modal) {
            // Markup missing — realistically a stale cached index.html paired
            // with a fresh module during an update. Degrade to confirm()
            // rather than failing either way: failing closed kills the mic
            // mid-game, and failing open would send audio to a third party
            // with no disclosure at all, which is the one outcome this gate
            // exists to prevent. confirm() needs no markup, so it always works.
            console.warn('[micButton] narration disclosure markup missing — using confirm() fallback');
            let accepted = false;
            try {
                accepted = window.confirm(DISCLOSURE_FALLBACK_TEXT);
            } catch (_) {
                // confirm() suppressed (some embedded webviews). Nothing left
                // that can disclose, so decline — undisclosed audio capture is
                // not an acceptable default.
                accepted = false;
            }
            if (accepted) {
                try {
                    localStorage.setItem(disclosureAckKey(), 'true');
                } catch (_) { /* storage disabled — they will see this again */ }
                onAccept();
            } else {
                render();
            }
            return;
        }
        disclosureOnAccept = onAccept;
        modal.style.display = 'flex';
    }

    function initDisclosure() {
        const cancelBtn = document.getElementById('narrationDisclosureCancelBtn');
        const enableBtn = document.getElementById('narrationDisclosureEnableBtn');

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                // Not remembered: declining once should not be read as a
                // permanent answer, and they get asked again next tap.
                closeDisclosure();
                render();
            });
        }

        if (enableBtn) {
            enableBtn.addEventListener('click', () => {
                try {
                    localStorage.setItem(disclosureAckKey(), 'true');
                } catch (_) { /* storage disabled — they will see this again */ }
                const resume = disclosureOnAccept;
                closeDisclosure();
                if (resume) resume();
            });
        }
    }

    // ---------------------------------------------------------------------
    // Recording actions — delegate to the active target
    // ---------------------------------------------------------------------

    function startRecording(target) {
        if (!isNarrationAvailable()) {
            console.warn('[micButton] Narration engine not available');
            return;
        }
        const blockedMessage = target.blocked(target.phase());
        if (blockedMessage) {
            if (typeof showControllerToast === 'function') {
                showControllerToast(blockedMessage, 'info');
            }
            return;
        }
        // First narration session on this device: say where the audio goes
        // before any of it leaves the browser. Gate here rather than inside
        // the two targets so both event and lineup narration are covered by
        // the one prompt, and so nothing has been opened yet if they cancel.
        if (!hasAcknowledgedDisclosure()) {
            showDisclosure(() => beginRecording(target));
            return;
        }
        beginRecording(target);
    }

    function beginRecording(target) {
        render();  // Show connecting state immediately
        Promise.resolve(target.start())
            .then(() => render())
            .catch(err => {
                console.error(`[micButton] ${target.name} start failed:`, err);
                render();
                if (isPermissionDenied(err)) {
                    showMicBlockedToast();
                    return;
                }
                if (typeof showControllerToast === 'function') {
                    // Not always a mic problem — the realtime socket can die
                    // during setup too (G5). Keep the message cause-neutral.
                    showControllerToast(target.failedToStart(err.message || err), 'error');
                }
            });
    }

    function stopRecording(target) {
        Promise.resolve(target.stop())
            .then(() => render())
            .catch(err => {
                console.error(`[micButton] ${target.name} stop failed:`, err);
                render();
            });
        render();
    }

    // ---------------------------------------------------------------------
    // Microphone permission denied
    //
    // A denied getUserMedia rejects with a DOMException named NotAllowedError
    // (PermissionDeniedError in old Chrome). Browsers don't ask twice: WebKit
    // remembers the answer for the life of the page and Chrome for the site,
    // so every later tap fails the same way at once — which reads as "the
    // mic is broken" to a coach who hit Deny by accident. So this toast says
    // how to get the prompt back, stays up long enough to be read, and
    // offers the coach who meant it a way to be rid of the button.
    // ---------------------------------------------------------------------

    const MIC_BLOCKED_TOAST_MS = 15000;

    function isPermissionDenied(err) {
        const name = (err && err.name) || (err && err.cause && err.cause.name);
        return name === 'NotAllowedError' || name === 'PermissionDeniedError';
    }

    function showMicBlockedToast() {
        if (typeof showControllerToast !== 'function') return;
        showControllerToast(
            'Microphone access was denied, so narration can\'t start. '
            + 'Reload Breakside (or close and reopen it), then tap the mic to be asked again — '
            + 'if it still doesn\'t ask, allow the microphone for this site in your browser settings.',
            'error',
            MIC_BLOCKED_TOAST_MS,
            { actions: [{ label: 'Hide mic button', onClick: hideMicButton }] }
        );
    }

    /** The toast's way out: narration off, button gone, and where it went. */
    function hideMicButton() {
        if (advancedSettings && advancedSettings.set) advancedSettings.set('narration.mode', 'off');
        render();
        if (typeof showControllerToast === 'function') {
            showControllerToast('Mic button hidden. Advanced Settings → Audio Narration brings it back.', 'info', 6000);
        }
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
        initDisclosure();
        render();

        // Visibility used to be discovered by polling isGameScreenVisible()
        // twice a second, forever, because "enterGameScreen/exitGameScreen
        // don't emit events". They do now: both call refreshVisibility()
        // directly (game/gameScreenSync.js), and this listener catches every
        // other navigation path.
        document.addEventListener('breakside:screen-shown', render);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Public API: the refresh hook both narration layers call on phase
    // transitions (there's no dedicated bus channel for phase; they invoke
    // window.narrationMicButton.refresh() directly), and the visibility hook
    // the game screen, the tab switch and Advanced Settings call. Both paint
    // the same thing now; two names are kept because the callers are split
    // by which signal they carry.
    return {
        refresh: render,
        refreshVisibility: render,
        // Debug/e2e seam: which subsystem a tap would drive right now.
        _currentTargetName: () => currentTarget().name
    };
})();

// --- ES-module export ---
export { narrationMicButton };
// window survivor: late-bound back-edge hook (called window-qualified by
// narration/narrationEngine.js setPhase and narration/lineupNarration.js
// setPhase — an engine↔micButton import cycle would invert their eval
// order; see setPhase)
window.narrationMicButton = narrationMicButton;
