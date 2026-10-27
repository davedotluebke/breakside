/*
 * Squad Narration — speak the squads in the scrimmage picker.
 *
 * The third narration layer, a sibling of lineupNarration.js: the same
 * transcription-only Realtime session for capture, its own state machine,
 * and its own backend endpoint (/api/narration/squads). It drives the New
 * Scrimmage / Edit Squads dialog (teams/scrimmageDialogs.js) rather than
 * the Line tab, through the dialog's narration seam
 * (getSquadDialogContext / applyNarratedSquads).
 *
 * No button of its own: the floating mic FAB (narration/micButton.js) routes
 * to this layer whenever the squad picker is open — on the team list, or
 * over a game for Edit Squads — with the same tap-toggle / hold-to-record
 * gestures as the other two layers. This module owns only the inline status
 * strip under the picker's Clear / Auto row.
 *
 * Flow:
 *   tap the mic with the picker open → transcription session opens
 *   (vocabulary biased to the whole roster AND the two squad names) → coach
 *   speaks ("Alice and Bob on Orange, Dana on Black", "Eve sits out",
 *   "everyone else on Black") → tap again → transcript + roster + squad
 *   names + current squads POST to /api/narration/squads → the derived
 *   squads replace the picker's assignment, the way taps would, and a toast
 *   says who moved. Names spoken without a squad go on the FIRST squad;
 *   that rule is the server's (narration_lineup.py), not the model's.
 */
import { narrationRealtimeSession, mergeCompletedUtterance } from './realtimeSession.js';
import { narrationEngine } from './narrationEngine.js';
import { lineupNarration } from './lineupNarration.js';
import { resolveSquadResult, buildSquadToast } from './squadResolve.js';
import { log } from '../utils/logger.js';
import { advancedSettings } from '../settings/advancedSettings.js';
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { showControllerToast, dismissToast } from '../game/controllerState.js';
import { getSquadDialogContext, applyNarratedSquads } from '../teams/scrimmageDialogs.js';

const squadNarration = (function() {
    const STATUS_ID = 'squadNarrationStatus';
    const SQUADS_ENDPOINT = '/api/narration/squads';
    const TRANSCRIPT_TAIL_CHARS = 120;

    // The confirmation toast reports a whole split, next to a picker that
    // shows it; lineupNarration's on-Line-tab lifetime is the right one.
    const CONFIRM_TOAST_MS = 4000 * 3;

    // 'idle' | 'connecting' | 'recording' | 'processing'
    let phase = 'idle';
    let abortRequested = false;
    let transcript = '';
    let confirmToast = null;

    function toast(message, type = 'info') {
        if (typeof showControllerToast === 'function') {
            showControllerToast(message, type);
        } else {
            console.warn(`[squadNarration] (no toast) ${type}: ${message}`);
        }
    }

    function showConfirmToast(message, type) {
        if (typeof showControllerToast !== 'function') {
            console.warn(`[squadNarration] (no toast) ${type}: ${message}`);
            return;
        }
        dismissConfirmToast();
        confirmToast = showControllerToast(message, type, CONFIRM_TOAST_MS,
            { onDismiss: () => { confirmToast = null; } });
    }

    function dismissConfirmToast() {
        if (!confirmToast) return;
        const t = confirmToast;
        confirmToast = null;
        if (typeof dismissToast === 'function') dismissToast(t);
    }

    // -----------------------------------------------------------------
    // UI: button state + status strip
    // -----------------------------------------------------------------

    function setPhase(p) {
        phase = p;
        refresh();
    }

    /** Sync the status strip, and re-render the shared mic FAB (it reads
     *  getPhase()). window-qualified: micButton imports us. */
    function refresh() {
        refreshStatusStrip();
        window.narrationMicButton?.refresh?.();
    }

    /** The "Listening… <transcript tail>" strip under the picker's tools
     *  row. Created lazily inside whichever squad dialog is open. */
    function ensureStatusEl() {
        let el = document.getElementById(STATUS_ID);
        if (el && el.isConnected) return el;
        const tools = document.querySelector('.scrimmage-dialog .scrimmage-tools');
        if (!tools) return null;
        el = document.createElement('div');
        el.id = STATUS_ID;
        el.className = 'lineup-narration-status';
        tools.insertAdjacentElement('afterend', el);
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
        const ctx = getSquadDialogContext();
        const names = ctx ? ctx.names : { X: 'Dark', Y: 'Light' };
        const labels = {
            connecting: 'Connecting…',
            recording: transcript.trim() ? ''
                : `Listening — "Alice and Bob on ${names.X}, Dana on ${names.Y}"; names alone go on ${names.X}`,
            processing: 'Working out the squads…'
        };
        const tail = transcript.length > TRANSCRIPT_TAIL_CHARS
            ? '…' + transcript.slice(-TRANSCRIPT_TAIL_CHARS)
            : transcript;
        el.textContent = labels[phase] || tail || '';
        if (phase === 'recording' && tail.trim()) el.textContent = tail;
        el.classList.add('visible');
    }

    function isSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    /** Whether a squad picker is open with its roster loaded — the mic
     *  button's cue to route to this layer. */
    function isDialogOpen() {
        return !!getSquadDialogContext();
    }

    // -----------------------------------------------------------------
    // Context gathering
    // -----------------------------------------------------------------

    function rosterInfo(roster) {
        return roster.map(p => ({
            name: p.name,
            nickname: p.nickname || null,
            number: p.number != null ? String(p.number) : null
        }));
    }

    /** {X: [names], Y: [names]} from the picker's id → squad map. */
    function currentSquadNames(ctx) {
        const out = { X: [], Y: [] };
        ctx.roster.forEach(p => {
            const squad = ctx.assignment.get(p.id);
            if (squad === 'X' || squad === 'Y') out[squad].push(p.name);
        });
        return out;
    }

    // -----------------------------------------------------------------
    // Start / stop
    // -----------------------------------------------------------------

    async function start() {
        if (phase !== 'idle') return;
        if (!isSupported()) {
            toast('Squad narration needs microphone support', 'warning');
            return;
        }
        const ctx = getSquadDialogContext();
        if (!ctx) {
            toast('Open the squad picker to narrate squads', 'warning');
            return;
        }
        if ((narrationEngine && narrationEngine.getPhase && narrationEngine.getPhase() !== 'idle')
            || (lineupNarration && lineupNarration.getPhase && lineupNarration.getPhase() !== 'idle')
            || (narrationRealtimeSession && narrationRealtimeSession.isActive())) {
            toast('Narration is already running — stop it before narrating squads', 'warning');
            return;
        }

        dismissConfirmToast();
        abortRequested = false;
        transcript = '';
        setPhase('connecting');

        // Vocabulary-bias toward the whole roster and the squad names: the
        // squad words are what tell this narration apart from a line call,
        // so the recognizer must get them right. The names ride along as
        // roster-shaped entries, which is all the vocabulary prompt reads.
        const info = rosterInfo(ctx.roster).concat([{ name: ctx.names.X }, { name: ctx.names.Y }]);
        const advOpts = (advancedSettings && advancedSettings.getNarrationSessionOptions)
            ? advancedSettings.getNarrationSessionOptions(info)
            : {};

        try {
            await narrationRealtimeSession.start({
                mode: 'transcription',
                ...advOpts,
                onTranscriptDelta: (delta) => {
                    transcript += delta;
                    refreshStatusStrip();
                },
                onTranscriptComplete: (utterance) => {
                    transcript = mergeCompletedUtterance(transcript, utterance);
                    refreshStatusStrip();
                },
                onError: (err) => {
                    console.error('[squadNarration] Session error:', err);
                    if (phase === 'recording') {
                        setPhase('idle');
                        toast('Squad narration stopped: ' + (err && err.message ? err.message : 'connection lost'), 'error');
                    } else if (phase === 'connecting') {
                        setPhase('idle');
                    }
                }
            });

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
            console.error('[squadNarration] start failed:', err);
            // Rethrown for the mic button, which tells a denied microphone
            // apart from everything else (narration/micButton.js).
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
            console.error('[squadNarration] session stop error:', err);
        }

        try {
            await processTranscript();
        } finally {
            setPhase('idle');
        }
    }

    async function processTranscript() {
        if (!transcript.trim()) {
            toast('No speech captured', 'warning');
            return;
        }
        const ctx = getSquadDialogContext();
        if (!ctx) {
            toast('Squad picker closed — nothing applied', 'info');
            return;
        }
        if (!ctx.teamId) {
            toast('Voice squads failed — team context lost', 'error');
            return;
        }

        const payload = {
            teamId: ctx.teamId,
            transcript: transcript,
            roster: rosterInfo(ctx.roster),
            squad_names: { X: ctx.names.X, Y: ctx.names.Y },
            current_squads: currentSquadNames(ctx)
        };

        let data;
        try {
            const apiBase = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
            const resp = await authFetch(`${apiBase}${SQUADS_ENDPOINT}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (!resp.ok) {
                const hint = resp.status === 503 ? 'not configured on the server'
                    : resp.status === 404 ? 'server needs an update'
                    : `${resp.status}`;
                toast(`Squad processing failed (${hint}) — squads unchanged`, 'error');
                return;
            }
            data = await resp.json();
        } catch (err) {
            console.error('[squadNarration] request failed:', err);
            toast('Squad processing failed (network) — squads unchanged', 'error');
            return;
        }

        applyResult(data);
    }

    /**
     * Apply the backend's squads to the open picker. The server returns the
     * FULL resulting squads (its current squads ± the voiced changes), so
     * applying is a plain replacement and the toast reports the delta. An
     * error result, or one that heard nothing, never touches the picker.
     */
    function applyResult(data) {
        if (!data || data.error) {
            if (data && data.error) console.warn('[squadNarration] server error:', data.error);
            toast('Voice squads failed — squads unchanged', 'error');
            return false;
        }
        const ctx = getSquadDialogContext();
        if (!ctx) {
            toast('Squad picker closed — nothing applied', 'info');
            return false;
        }
        const voicedAssign = Array.isArray(data.voiced_assign) ? data.voiced_assign : [];
        const voicedOut = Array.isArray(data.out) ? data.out : [];
        const modelUnmatched = Array.isArray(data.unmatched) ? data.unmatched : [];
        const heard = voicedAssign.length || voicedOut.length || data.voiced_clear === true || !!data.voiced_rest;
        if (!heard && !modelUnmatched.length) {
            toast('No squad changes heard', 'info');
            return false;
        }

        const result = resolveSquadResult(data, ctx);
        if (!heard) {
            // Only unmatched references: nothing to apply, say what was missed.
            const shown = result.unmatched.slice(0, 3).map(u => `"${u}"`).join(', ');
            toast(`No roster match: ${shown}${result.unmatched.length > 3 ? ', …' : ''} — squads unchanged`, 'warning');
            return false;
        }

        if (!applyNarratedSquads(result.assignment)) return false;

        if (data.note) log('[squadNarration] note:', data.note);
        const { message, type } = buildSquadToast({
            names: ctx.names, counts: result.counts,
            moved: result.moved, removed: result.removed, unmatched: result.unmatched
        });
        showConfirmToast(message, type);
        return true;
    }

    function toggle() {
        if (phase === 'idle') {
            start();
        } else if (phase === 'connecting' || phase === 'recording') {
            stop();
        } else {
            toast('Still working out the previous squads…', 'info');
        }
    }

    // -----------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------

    // The picker closing mid-recording ends the recording: there is nothing
    // left to apply it to (processTranscript checks again and says so). Its
    // report is moot once the dialog is gone, too.
    document.addEventListener('breakside:scrimmage-dialog', (e) => {
        if (e.detail && e.detail.open) return;
        dismissConfirmToast();
        if (phase === 'recording' || phase === 'connecting') stop();
    });

    return {
        start,
        stop,
        toggle,
        getPhase: () => phase,
        isActive: () => phase !== 'idle',
        isDialogOpen,
        refresh,
        // Debug/e2e seams: drive the apply path without mic or backend
        // (squadNarration._applyResult({squads: {X: ['Alice'], Y: []}})).
        _applyResult: applyResult,
        _getTranscript: () => transcript
    };
})();

// --- ES-module export ---
export { squadNarration };
// window survivor: debug/e2e seam — lets the console and Playwright drive
// the apply path (squadNarration._applyResult) without mic hardware or a
// configured ANTHROPIC_API_KEY; mirrors lineupNarration's seam.
window.squadNarration = squadNarration;
