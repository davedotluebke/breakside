/*
 * Roster Narration — the capture layer the two "say who" narrations share.
 *
 * Lineup narration (the next point's line, narration/lineupNarration.js) and
 * squad narration (a scrimmage's two squads, narration/squadNarration.js) do
 * the same thing with different lists: open a transcription-only Realtime
 * session biased toward the roster, show what is being heard in a strip next
 * to the list, POST the transcript and the list's state to their endpoint
 * when the coach stops, and apply the answer the way taps would. Everything
 * that is the same lives here, once: the state machine (idle → connecting →
 * recording → processing), cancelling a half-open session, the status strip,
 * the request and its failure toasts, the long-lived confirmation toast, and
 * the debug seams. A layer is a spec handed to createRosterNarration():
 * where its strip goes, how to read its context, what to send, how to apply.
 *
 * Neither layer has a button of its own: the floating mic FAB
 * (narration/micButton.js) picks one and drives start() / stop(). Only one
 * can record at a time — they share the realtime-session singleton with
 * each other and with in-point narration — so every layer made here refuses
 * to start while any other narration is running.
 *
 * The server halves are siblings in the same way: narration_lineup.py and
 * narration_squads.py over narration_common.py.
 */
import { narrationRealtimeSession } from './realtimeSession.js';
import { narrationEngine } from './narrationEngine.js';
import { narrationEventBus } from './eventBus.js';
import { advancedSettings } from '../settings/advancedSettings.js';
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { showControllerToast, dismissToast } from '../game/controllerState.js';

const TRANSCRIPT_TAIL_CHARS = 120;

// The gender-group words, for the recognizer: said as initialisms they are
// otherwise transcribed every which way. Both servers read "the FMPs" and
// "two more MMPs" (narration_common.py _GROUP_LEXICON).
const GROUP_VOCABULARY = ['FMP', 'FMPs', 'MMP', 'MMPs'];

// Every layer made by createRosterNarration, so each can see the others.
const layers = [];

/** name / nickname / number per player — what the recognizer's vocabulary
 *  hint reads and the least a server needs to match a spoken reference. */
function rosterInfo(roster) {
    return (roster || []).map(p => ({
        name: p.name,
        nickname: p.nickname || null,
        number: p.number != null ? String(p.number) : null
    }));
}

/** rosterInfo plus each player's gender group ("the FMPs", "two more
 *  guys") and whatever else a layer's server needs per player. */
function rosterForServer(roster, extra = () => ({})) {
    return (roster || []).map(p => ({
        name: p.name,
        nickname: p.nickname || null,
        number: p.number != null ? String(p.number) : null,
        gender: p.gender || null,
        ...extra(p)
    }));
}

/**
 * Make a narration layer.
 *
 * @param {object} spec
 * @param {string} spec.name            log prefix and debug name ('lineupNarration')
 * @param {string} spec.label           capitalised noun for messages ('Lineup', 'Squad')
 * @param {string} spec.voiceLabel      what a failed voice action is called ('Voice lineup')
 * @param {string} spec.unchanged       what stays as it was on failure ('selection', 'squads')
 * @param {string} spec.endpoint        '/api/narration/lineup'
 * @param {string} [spec.resultChannel] event-bus channel on which a spoken
 *        session's request and answer are announced ('lineupResolved'), for
 *        the clip recorder (narration/clipRecorder.js)
 * @param {string} spec.statusId        DOM id of the status strip
 * @param {() => Element|null} spec.statusAnchor  element the strip is inserted after
 * @param {(ctx: object|null) => string} spec.listeningHint  strip text before any words arrive
 * @param {string} spec.processingLabel 'Working out the lineup…'
 * @param {string} spec.busyMessage     toast for a tap while processing
 * @param {string} spec.otherRunningMessage  toast when another narration holds the session
 * @param {(stage: 'start'|'process'|'apply') => {ctx?: object, problem?: string, level?: string}}
 *        spec.context  the list's current state, or why it cannot be narrated right now
 * @param {(ctx: object) => Array<{name: string, nickname?: string}>} spec.vocabulary
 *        roster-shaped entries to bias the recognizer toward
 * @param {(ctx: object, transcript: string) => object} spec.buildPayload
 * @param {(data: object, ctx: object, ui: object) => boolean} spec.apply
 *        apply a good answer; ui = { toast, showConfirmToast }
 * @param {() => number} spec.confirmToastMs  lifetime of the confirmation toast
 * @returns {object} the layer: start / stop / toggle / getPhase / isActive /
 *          refresh / dismissConfirmToast, and the debug seams
 */
function createRosterNarration(spec) {
    // 'idle' | 'connecting' | 'recording' | 'processing'
    let phase = 'idle';
    // Stop requested while the realtime session was still connecting; the
    // start() continuation tears the half-open session down (same pattern
    // as narrationEngine — never leave the mic hot after a cancel).
    let abortRequested = false;
    let transcript = '';
    // The long-lived confirmation toast, held so the layer can retire it
    // early once the coach has visibly moved on. Cleared by its own
    // onDismiss, so a manual close/swipe doesn't leave a detached node.
    let confirmToast = null;

    function toast(message, type = 'info') {
        if (typeof showControllerToast === 'function') {
            showControllerToast(message, type);
        } else {
            console.warn(`[${spec.name}] (no toast) ${type}: ${message}`);
        }
    }

    /** The "here's what I did" toast. Outlives a normal toast and is
     *  dismissed early by dismissConfirmToast() rather than left to time out
     *  after the coach has already acted on it. Never two at once. */
    function showConfirmToast(message, type) {
        if (typeof showControllerToast !== 'function') {
            console.warn(`[${spec.name}] (no toast) ${type}: ${message}`);
            return;
        }
        dismissConfirmToast();
        confirmToast = showControllerToast(message, type, spec.confirmToastMs(),
            { onDismiss: () => { confirmToast = null; } });
    }

    /** Safe to call when there isn't one (or when the coach already closed
     *  it — dismissToast no-ops on a node that's out of the DOM). */
    function dismissConfirmToast() {
        if (!confirmToast) return;
        const t = confirmToast;
        confirmToast = null;
        if (typeof dismissToast === 'function') dismissToast(t);
    }

    // -----------------------------------------------------------------
    // Phase and the status strip
    // -----------------------------------------------------------------

    function setPhase(p) {
        phase = p;
        refresh();
    }

    /** Sync the status strip to `phase`, and nudge the shared mic FAB to
     *  re-render — it reads getPhase() to pick its colour and tooltip.
     *  window-qualified: micButton imports the layers, so importing it back
     *  would make a cycle (same pattern as narrationEngine's setPhase). */
    function refresh() {
        refreshStatusStrip();
        window.narrationMicButton?.refresh?.();
    }

    /** The inline "Listening… <transcript tail>" strip. Created lazily after
     *  the layer's anchor; recreated if a rebuild of the list ate it. */
    function ensureStatusEl() {
        let el = document.getElementById(spec.statusId);
        if (el && el.isConnected) return el;
        const anchor = spec.statusAnchor();
        if (!anchor) return null;
        el = document.createElement('div');
        el.id = spec.statusId;
        el.className = 'lineup-narration-status';
        anchor.insertAdjacentElement('afterend', el);
        return el;
    }

    function refreshStatusStrip() {
        const el = ensureStatusEl();
        if (!el) return;
        if (phase === 'idle') {
            el.classList.remove('visible');
            el.textContent = '';
            return;
        }
        const tail = transcript.length > TRANSCRIPT_TAIL_CHARS
            ? '…' + transcript.slice(-TRANSCRIPT_TAIL_CHARS)
            : transcript;
        let text;
        if (phase === 'connecting') text = 'Connecting…';
        else if (phase === 'processing') text = spec.processingLabel;
        else text = tail.trim() ? tail : spec.listeningHint(spec.context('start').ctx || null);
        el.textContent = text || '';
        el.classList.add('visible');
    }

    function isSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    /** Is anything else holding (or about to hold) the realtime session? */
    function otherNarrationRunning() {
        if (narrationEngine && narrationEngine.getPhase && narrationEngine.getPhase() !== 'idle') return true;
        if (layers.some(l => l !== layer && l.getPhase() !== 'idle')) return true;
        return !!(narrationRealtimeSession && narrationRealtimeSession.isActive());
    }

    // -----------------------------------------------------------------
    // Start / stop
    // -----------------------------------------------------------------

    async function start() {
        if (phase !== 'idle') return;
        if (!isSupported()) {
            toast(`${spec.label} narration needs microphone support`, 'warning');
            return;
        }
        const { ctx, problem, level } = spec.context('start');
        if (!ctx) {
            toast(problem, level || 'warning');
            return;
        }
        // The realtime session is a singleton. Refuse with a clear message
        // rather than letting start() throw.
        if (otherNarrationRunning()) {
            toast(spec.otherRunningMessage, 'warning');
            return;
        }

        // Narrating again supersedes the previous report.
        dismissConfirmToast();

        abortRequested = false;
        transcript = '';
        setPhase('connecting');

        // Vocabulary-bias transcription toward what this layer's coach is
        // about to say — the whole roster (a line call names bench players),
        // the layer's own words, and the gender-group initialisms.
        const info = spec.vocabulary(ctx).concat(GROUP_VOCABULARY.map(name => ({ name })));
        const advOpts = (advancedSettings && advancedSettings.getNarrationSessionOptions)
            ? advancedSettings.getNarrationSessionOptions(info)
            : {};

        try {
            await narrationRealtimeSession.start({
                mode: 'transcription',
                ...advOpts,
                // The second argument is the session's whole transcript, kept
                // per utterance with a space between them (transcriptItems.js).
                onTranscriptDelta: (delta, sessionTranscript) => {
                    transcript = sessionTranscript;
                    refreshStatusStrip();
                },
                onTranscriptComplete: (utterance, sessionTranscript) => {
                    transcript = sessionTranscript;
                    refreshStatusStrip();
                },
                onError: (err) => {
                    console.error(`[${spec.name}] Session error:`, err);
                    // Mirror narrationEngine: a death while recording resets +
                    // toasts here; a connect-phase failure surfaces through
                    // start()'s throw path, so stay silent to avoid doubles.
                    if (phase === 'recording') {
                        setPhase('idle');
                        toast(`${spec.label} narration stopped: `
                            + (err && err.message ? err.message : 'connection lost'), 'error');
                    } else if (phase === 'connecting') {
                        setPhase('idle');
                    }
                }
            });

            // Cancelled while connecting: tear the just-opened session down.
            if (abortRequested) {
                abortRequested = false;
                try {
                    if (narrationRealtimeSession.isActive()) {
                        await narrationRealtimeSession.stop();
                    }
                } catch (_) { /* best-effort teardown */ }
                setPhase('idle');
                return;
            }

            setPhase('recording');
        } catch (err) {
            abortRequested = false;
            setPhase('idle');
            console.error(`[${spec.name}] start failed:`, err);
            // Rethrown rather than toasted here, the same as narrationEngine's
            // startRecording: the mic button reports start failures for every
            // layer, and it is the one that tells a denied microphone apart
            // from everything else (narration/micButton.js).
            throw err;
        }
    }

    async function stop() {
        if (phase === 'connecting') {
            abortRequested = true;
            return;
        }
        if (phase !== 'recording') return;

        setPhase('processing');
        try {
            if (narrationRealtimeSession.isActive()) {
                const result = await narrationRealtimeSession.stop();
                if (result && result.transcript) {
                    transcript = result.transcript;
                }
            }
        } catch (err) {
            console.error(`[${spec.name}] session stop error:`, err);
        }

        try {
            await processTranscript();
        } finally {
            setPhase('idle');
        }
    }

    /** `typed` marks the _narrate seam: no session was recorded, so there
     *  is no result to announce for one. */
    async function processTranscript({ typed = false } = {}) {
        if (!transcript.trim()) {
            // Same signature as a dead audio path (G5) — always say something.
            toast('No speech captured', 'warning');
            return;
        }
        const { ctx, problem, level } = spec.context('process');
        if (!ctx) {
            toast(problem, level || 'error');
            return;
        }

        let data;
        try {
            const apiBase = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
            const payload = spec.buildPayload(ctx, transcript);
            const resp = await authFetch(`${apiBase}${spec.endpoint}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (!resp.ok) {
                const hint = resp.status === 503 ? 'not configured on the server'
                    : resp.status === 404 ? 'server needs an update'
                    : `${resp.status}`;
                toast(`${spec.label} processing failed (${hint}) — ${spec.unchanged} unchanged`, 'error');
                return;
            }
            data = await resp.json();
            // For the clip recorder: what the pass was asked, and its answer.
            if (spec.resultChannel && !typed) {
                narrationEventBus.publish(spec.resultChannel, { transcript, request: payload, response: data });
            }
        } catch (err) {
            console.error(`[${spec.name}] request failed:`, err);
            toast(`${spec.label} processing failed (network) — ${spec.unchanged} unchanged`, 'error');
            return;
        }

        applyResult(data);
    }

    /** Apply a server answer. An error result never touches the list — a
     *  wrong no-op beats wiping what the coach has. The context is read
     *  again here: a role can move, or a dialog close, while recording. */
    function applyResult(data) {
        if (!data || data.error) {
            if (data && data.error) console.warn(`[${spec.name}] server error:`, data.error);
            toast(`${spec.voiceLabel} failed — ${spec.unchanged} unchanged`, 'error');
            return false;
        }
        const { ctx, problem, level } = spec.context('apply');
        if (!ctx) {
            toast(problem, level || 'warning');
            return false;
        }
        return spec.apply(data, ctx, { toast, showConfirmToast }) === true;
    }

    function toggle() {
        if (phase === 'idle') {
            start();
        } else if (phase === 'connecting' || phase === 'recording') {
            stop();
        } else {
            toast(spec.busyMessage, 'info');
        }
    }

    const layer = {
        start,
        stop,
        toggle,
        getPhase: () => phase,
        isActive: () => phase !== 'idle',
        refresh,
        dismissConfirmToast,
        // Debug/e2e seams. _applyResult drives the apply path without mic or
        // backend; _narrate drives everything after the recognizer — the
        // real request, server and model — from typed words
        // (await lineupNarration._narrate('Kris in for Wes')).
        _applyResult: applyResult,
        _narrate: async (text) => {
            if (phase !== 'idle') return false;
            transcript = String(text || '');
            await processTranscript({ typed: true });
            return true;
        },
        _getTranscript: () => transcript
    };
    layers.push(layer);
    return layer;
}

export { createRosterNarration, rosterInfo, rosterForServer, GROUP_VOCABULARY };
