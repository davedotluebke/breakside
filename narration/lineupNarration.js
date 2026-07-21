/*
 * Lineup Narration — speak the next line on the Lines tab.
 *
 * A SEPARATE layer on top of the base narration plumbing. It reuses
 * narrationRealtimeSession (transcription-only mode) for capture and the
 * Advanced Settings narration knobs, but has its own mic button (in the
 * Select Line toolbar), its own state machine, and its own backend
 * endpoint (/api/narration/lineup). It never touches the in-point
 * narration engine beyond checking that it's idle — the two can't record
 * at once because they share the realtime-session singleton.
 *
 * Flow:
 *   tap #lineupMicBtn → transcription session opens (vocabulary biased to
 *   the FULL active roster — calling a line names bench players) → coach
 *   speaks ("Cyrus goes in for Nate", "same line but…", corrections) →
 *   tap again → transcript + roster + expected count + previous lineup +
 *   current selection POST to /api/narration/lineup → returned players
 *   are applied through selectLine's applyLineSelection (same path as the
 *   Auto button), replacing the active line's selection.
 *
 * The mic button lives in DOM built by gameScreenPanels; clicks are
 * delegated on document so panel rebuilds can't orphan the handler.
 */
import { narrationRealtimeSession, mergeCompletedUtterance } from './realtimeSession.js';
import { narrationEngine } from './narrationEngine.js';
import { resolveLineupPlayers, buildLineupToast, displayFirstName } from './lineupResolve.js';
import { log } from '../utils/logger.js';
import { advancedSettings } from '../settings/advancedSettings.js';
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { getActiveRoster } from '../store/storage.js';
import { currentGame, buildPointPlayerLookup } from '../utils/helpers.js';
import { showControllerToast } from '../game/controllerState.js';
import { applyLineSelection, canEditSelectLinePanel } from '../game/selectLine.js';

const lineupNarration = (function() {
    const BTN_ID = 'lineupMicBtn';
    const STATUS_ID = 'lineupNarrationStatus';
    const LINEUP_ENDPOINT = '/api/narration/lineup';
    const TRANSCRIPT_TAIL_CHARS = 120;

    // 'idle' | 'connecting' | 'recording' | 'processing'
    let phase = 'idle';
    // Stop requested while the realtime session was still connecting; the
    // start() continuation tears the half-open session down (same pattern
    // as narrationEngine — never leave the mic hot after a cancel).
    let abortRequested = false;
    let transcript = '';

    function toast(message, type = 'info') {
        if (typeof showControllerToast === 'function') {
            showControllerToast(message, type);
        } else {
            console.warn(`[lineupNarration] (no toast) ${type}: ${message}`);
        }
    }

    // -----------------------------------------------------------------
    // UI: button state + status strip
    // -----------------------------------------------------------------

    function setPhase(p) {
        phase = p;
        refresh();
    }

    /** Sync the mic button's classes/title and the status strip to `phase`.
     *  Re-queries the DOM each time — the Lines panel can be rebuilt. */
    function refresh() {
        const btn = document.getElementById(BTN_ID);
        if (btn) {
            btn.classList.remove('mic-idle', 'mic-connecting', 'mic-recording', 'mic-processing', 'mic-disabled');
            if (!isSupported()) {
                btn.classList.add('mic-disabled');
                btn.title = 'Lineup narration unavailable (no microphone support)';
            } else if (phase === 'connecting') {
                btn.classList.add('mic-connecting');
                btn.title = 'Connecting…';
            } else if (phase === 'recording') {
                btn.classList.add('mic-recording');
                btn.title = 'Listening — tap to finish the lineup';
            } else if (phase === 'processing') {
                btn.classList.add('mic-processing');
                btn.title = 'Working out the lineup…';
            } else {
                btn.classList.add('mic-idle');
                btn.title = 'Narrate the next line — tap, speak names or subs, tap again';
            }
        }
        refreshStatusStrip();
    }

    /** The inline "Listening… <transcript tail>" strip under the toolbar.
     *  Created lazily inside the Lines panel; recreated if a rebuild ate it. */
    function ensureStatusEl() {
        let el = document.getElementById(STATUS_ID);
        if (el) return el;
        const toolbar = document.querySelector('.panel-selectLine .select-line-toolbar');
        if (!toolbar) return null;
        el = document.createElement('div');
        el.id = STATUS_ID;
        el.className = 'lineup-narration-status';
        toolbar.insertAdjacentElement('afterend', el);
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
        const labels = {
            connecting: 'Connecting…',
            recording: transcript.trim() ? '' : 'Listening — name the line, or call subs like "Cyrus in for Nate"',
            processing: 'Working out the lineup…'
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

    // -----------------------------------------------------------------
    // Context gathering
    // -----------------------------------------------------------------

    function getExpectedCount() {
        // Same idiom as selectLine.js — the game-settings field, default 7.
        return parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
    }

    /** Names of the last point's line — who just played / is on the field.
     *  Entries may be ids (id-era games); resolve through the era-aware lookup. */
    function getPreviousLineupNames(game) {
        if (!game || !game.points || !game.points.length) return [];
        const pt = game.points[game.points.length - 1];
        if (!pt || !pt.players || !pt.players.length) return [];
        const lookup = buildPointPlayerLookup(game);
        return pt.players.map(entry => lookup(entry).name).filter(Boolean);
    }

    /** Names currently selected on the active line bucket (what we replace). */
    function getCurrentSelectionNames(game) {
        const pending = game && game.pendingNextLine;
        if (!pending) return [];
        const activeType = pending.activeType || 'od';
        const entries = pending[activeType + 'Line'] || [];
        if (!entries.length) return [];
        const lookup = buildPointPlayerLookup(game);
        return entries.map(entry => lookup(entry).name).filter(Boolean);
    }

    function rosterInfo(roster) {
        return roster.map(p => ({
            name: p.name,
            nickname: p.nickname || null,
            number: p.number != null ? String(p.number) : null
        }));
    }

    // -----------------------------------------------------------------
    // Start / stop
    // -----------------------------------------------------------------

    async function start() {
        if (phase !== 'idle') return;
        if (!isSupported()) {
            toast('Lineup narration needs microphone support', 'warning');
            return;
        }
        const game = typeof currentGame === 'function' ? currentGame() : null;
        if (!game) {
            toast('Open a game to narrate a lineup', 'warning');
            return;
        }
        if (!canEditSelectLinePanel()) {
            toast('You need a coach role to change the line', 'warning');
            return;
        }
        // The realtime session is a singleton shared with in-point narration.
        // Refuse with a clear message rather than letting start() throw.
        if ((narrationEngine && narrationEngine.getPhase && narrationEngine.getPhase() !== 'idle')
            || (narrationRealtimeSession && narrationRealtimeSession.isActive())) {
            toast('Game narration is running — stop it before narrating the lineup', 'warning');
            return;
        }
        const roster = typeof getActiveRoster === 'function' ? getActiveRoster() : null;
        if (!roster || !roster.length) {
            toast('No roster to match a lineup against', 'warning');
            return;
        }

        abortRequested = false;
        transcript = '';
        setPhase('connecting');

        // Vocabulary-bias transcription toward the FULL roster — a line call
        // names bench players, so on-field-only biasing (the in-point default)
        // would miss exactly the names that matter here.
        const info = rosterInfo(roster);
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
                    console.error('[lineupNarration] Session error:', err);
                    // Mirror narrationEngine: a death while recording resets +
                    // toasts here; a connect-phase failure surfaces through
                    // start()'s throw path, so stay silent to avoid doubles.
                    if (phase === 'recording') {
                        setPhase('idle');
                        toast('Lineup narration stopped: ' + (err && err.message ? err.message : 'connection lost'), 'error');
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
            console.error('[lineupNarration] start failed:', err);
            toast('Lineup narration failed to start: ' + (err && err.message ? err.message : err), 'error');
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
            console.error('[lineupNarration] session stop error:', err);
        }

        try {
            await processTranscript();
        } finally {
            setPhase('idle');
        }
    }

    async function processTranscript() {
        if (!transcript.trim()) {
            // Same signature as a dead audio path (G5) — always say something.
            toast('No speech captured', 'warning');
            return;
        }
        const game = typeof currentGame === 'function' ? currentGame() : null;
        const roster = typeof getActiveRoster === 'function' ? getActiveRoster() : [];
        if (!game || !roster || !roster.length) {
            toast('Voice lineup failed — game context lost', 'error');
            return;
        }

        const payload = {
            game_id: game.id || null,
            transcript: transcript,
            roster: rosterInfo(roster),
            expected_count: getExpectedCount(),
            previous_lineup: getPreviousLineupNames(game),
            current_selection: getCurrentSelectionNames(game)
        };

        let data;
        try {
            const apiBase = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
            const resp = await authFetch(`${apiBase}${LINEUP_ENDPOINT}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (!resp.ok) {
                const hint = resp.status === 503 ? 'not configured on the server'
                    : resp.status === 404 ? 'server needs an update'
                    : `${resp.status}`;
                toast(`Lineup processing failed (${hint}) — selection unchanged`, 'error');
                return;
            }
            data = await resp.json();
        } catch (err) {
            console.error('[lineupNarration] request failed:', err);
            toast('Lineup processing failed (network) — selection unchanged', 'error');
            return;
        }

        applyResult(data);
    }

    /**
     * Apply the backend's lineup to the Lines tab. The model returns the
     * FULL resulting lineup — partial utterances are resolved as additions
     * against the current selection server-side — so applying is a plain
     * replace, and the toast reports the DELTA ("Added: …", "Off: …").
     * Never applies an empty or error result — a wrong no-op beats wiping
     * the coach's selection.
     */
    function applyResult(data) {
        if (!data || data.error) {
            if (data && data.error) console.warn('[lineupNarration] server error:', data.error);
            toast('Voice lineup failed — selection unchanged', 'error');
            return false;
        }
        const returned = Array.isArray(data.players) ? data.players : [];
        const modelUnmatched = Array.isArray(data.unmatched) ? data.unmatched : [];
        if (!returned.length && !modelUnmatched.length) {
            toast('No lineup heard', 'info');
            return false;
        }

        const game = typeof currentGame === 'function' ? currentGame() : null;
        const roster = typeof getActiveRoster === 'function' ? getActiveRoster() : [];
        const { players, unmatched: localUnmatched } = resolveLineupPlayers(returned, roster);
        const unmatched = modelUnmatched.concat(localUnmatched);

        if (!players.length) {
            const shown = unmatched.slice(0, 3).map(u => `"${u}"`).join(', ');
            toast(`No roster match: ${shown}${unmatched.length > 3 ? ', …' : ''} — selection unchanged`, 'warning');
            return false;
        }
        // Re-check: the Line Coach role can move while recording.
        if (!canEditSelectLinePanel()) {
            toast('You need a coach role to change the line', 'warning');
            return false;
        }

        // Delta vs the selection being replaced — what this voice action did.
        const prevNames = getCurrentSelectionNames(game);
        const newNames = players.map(p => p.name);
        const prevSet = new Set(prevNames);
        const newSet = new Set(newNames);
        const added = newNames.filter(n => !prevSet.has(n)).map(displayFirstName);
        const removed = prevNames.filter(n => !newSet.has(n)).map(displayFirstName);

        applyLineSelection('main', newNames);

        // The model's free-text note is for debugging, not the sideline.
        if (data.note) log('[lineupNarration] note:', data.note);
        const { message, type } = buildLineupToast({
            selectedCount: newNames.length,
            expectedCount: getExpectedCount(),
            added, removed, unmatched
        });
        toast(message, type);
        return true;
    }

    function toggle() {
        if (phase === 'idle') {
            start();
        } else if (phase === 'connecting' || phase === 'recording') {
            stop();
        } else {
            toast('Still working out the previous lineup…', 'info');
        }
    }

    // -----------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------

    // Delegated: the button is inside panel DOM that gameScreenPanels can
    // rebuild; a document-level listener survives that.
    document.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest(`#${BTN_ID}`)) {
            e.preventDefault();
            toggle();
        }
    });

    // Public API
    return {
        toggle,
        getPhase: () => phase,
        isActive: () => phase !== 'idle',
        refresh,
        // Debug/e2e seams: drive the apply path without mic or backend
        // (e.g. lineupNarration._applyResult({players: ['Alice']})), and
        // inspect the transcript mid-recording.
        _applyResult: applyResult,
        _getTranscript: () => transcript
    };
})();

// --- ES-module export ---
export { lineupNarration };
// window survivor: debug/e2e seam — lets the console and Playwright drive
// the apply path (lineupNarration._applyResult) without mic hardware or a
// configured ANTHROPIC_API_KEY; mirrors the computeAutoLine seam.
window.lineupNarration = lineupNarration;
