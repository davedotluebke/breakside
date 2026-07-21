/*
 * Narration Engine
 *
 * Orchestrates the two-pass hybrid:
 *   - Fast pass: OpenAI Realtime API → provisional events (during recording)
 *   - Slow pass: /api/narration/finalize → finalized events (on stop)
 *
 * Public API (exposed as window.narrationEngine):
 *   - startRecording(): Promise — opens the Realtime session + mic
 *   - stopRecording():  Promise — closes mic + session, kicks off slow pass
 *   - isRecording():    boolean
 *   - getPhase():       'idle' | 'connecting' | 'recording' | 'finalizing'
 *
 * When function calls arrive from the fast pass, they are translated into
 * game Event objects using the SAME patterns as the manual dialogs in
 * playByPlay/keyPlayDialog.js (ensurePossessionExists, stats updates, etc.).
 * Each provisional event is tagged with a provisional id and published to
 * narrationEventBus.
 *
 * When the slow pass returns, its operations (CONFIRM/AMEND/RETRACT/ADD) are
 * applied by mutating the possession's events array and publishing bus events.
 */
import { Throw, Turnover, Defense, Role } from '../store/models.js';
import { saveAllTeamsData } from '../store/storage.js';
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { buildPointPlayerLookup, currentGame, getPlayerFromName } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { showControllerToast } from '../game/controllerState.js';
import { updateScore } from '../game/gameLogic.js';
import { moveToNextPoint } from '../game/pointManagement.js';
import { ensurePossessionExists } from '../playByPlay/keyPlayDialog.js';
import { advancedSettings } from '../settings/advancedSettings.js';
import { narrationEventBus } from './eventBus.js';
import { narrationRealtimeSession, mergeCompletedUtterance } from './realtimeSession.js';

const narrationEngine = (function() {
    const FINALIZE_ENDPOINT = '/api/narration/finalize';
    // OpenAI Realtime API GA model. The older `gpt-4o-realtime-preview` has
    // graduated; `gpt-realtime` is the current production identifier.
    // `gpt-realtime-mini` is a cheaper variant if cost becomes a concern.
    const REALTIME_MODEL = 'gpt-realtime';

    // The fast pass is TRANSCRIPTION ONLY. Live event extraction during
    // recording (gpt-realtime function calls) was the original design but
    // proved unreliable in noisy outdoor conditions — the model confabulates
    // events from garbled audio fragments. That path (buildTools /
    // buildInstructions / handleFunctionCall + a FAST_PASS_EVENTS_ENABLED
    // flag) was removed; recover it from git history if we ever revisit.
    // The live transcript streams to the UI so the coach can see they're
    // being heard; events are produced by the slow pass on stop (Claude via
    // /api/narration/finalize), whose ADD operation routes through the
    // shared apply* functions below.

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------
    let phase = 'idle';  // 'idle' | 'connecting' | 'recording' | 'finalizing'
    let recording = false;
    // Set when stop is requested while we're still 'connecting' (the realtime
    // session is mid-handshake). startRecording()'s continuation checks this
    // once start() resolves and tears the half-open session down, so a cancel
    // during connect never leaves the mic hot.
    let abortRequested = false;
    let provisionalEvents = [];  // { id, event, possession, pointIndex }
    let accumulatedTranscript = '';
    let provisionalIdCounter = 0;

    /**
     * User-visible narration feedback. Narration failures were historically
     * console-only, which is how G5 shipped broken for two weeks — a dead
     * session looked identical to a quiet one. Route through the shared toast
     * system; falls back to console when the toast container isn't mounted.
     */
    function toast(message, type = 'info') {
        if (typeof showControllerToast === 'function') {
            showControllerToast(message, type);
        } else {
            console.warn(`[narrationEngine] (no toast container) ${type}: ${message}`);
        }
    }

    function setPhase(p) {
        phase = p;
        // micButton is reached via window (not an import): importing it here
        // would invert the eval order (micButton before engine) and create an
        // engine↔micButton cycle — micButton's init() would then run before
        // the engine exists. Call-time window lookup preserves the old order.
        if (window.narrationMicButton && window.narrationMicButton.refresh) {
            window.narrationMicButton.refresh();
        }
    }

    function isRecording() { return recording; }
    function getPhase() { return phase; }

    /**
     * Transcription-only system prompt. We hand the model the player names
     * so it can transcribe them accurately (otherwise "Cyrus" might come out
     * as "Sirius" etc.) but give it nothing else to do — no tools, no event
     * extraction. The slow pass handles all that on stop.
     */
    function buildTranscriptOnlyInstructions(rosterInfo) {
        const names = rosterInfo
            .flatMap(p => [p.name, p.nickname].filter(Boolean))
            .join(', ');

        return `You are passively listening to a coach narrate an ultimate frisbee game.
Your only job is to enable accurate transcription of the audio.

Player names you may hear (use exact spellings): ${names || '(unknown)'}.

Do not respond. Do not call any tools. Do not produce any text output.
Just listen. Transcription happens automatically.`;
    }

    // -----------------------------------------------------------------
    // Player name resolution
    // -----------------------------------------------------------------

    /**
     * Fuzzy-match a spoken name to a player on the field.
     * Strategy (in order):
     *   1. Exact name match
     *   2. Exact nickname match
     *   3. Case-insensitive startsWith on name or nickname
     *   4. Jersey number ("number 7", "#7", or just "7")
     *   5. First-name-only match
     * Returns a Player object or null.
     */
    function resolvePlayerName(spokenName, onFieldPlayers) {
        if (!spokenName || !onFieldPlayers || !onFieldPlayers.length) return null;
        const spoken = String(spokenName).trim();
        const lower = spoken.toLowerCase();

        // 1. Exact name
        for (const p of onFieldPlayers) {
            if (p.name === spoken) return p;
        }
        // 2. Exact nickname
        for (const p of onFieldPlayers) {
            if (p.nickname && p.nickname === spoken) return p;
        }
        // 3. Case-insensitive name / nickname
        for (const p of onFieldPlayers) {
            if (p.name && p.name.toLowerCase() === lower) return p;
            if (p.nickname && p.nickname.toLowerCase() === lower) return p;
        }
        // 4. StartsWith
        for (const p of onFieldPlayers) {
            if (p.name && p.name.toLowerCase().startsWith(lower)) return p;
            if (p.nickname && p.nickname.toLowerCase().startsWith(lower)) return p;
        }
        // 5. Jersey number
        const numMatch = spoken.match(/(\d+)/);
        if (numMatch) {
            const num = numMatch[1];
            for (const p of onFieldPlayers) {
                if (p.number && String(p.number) === num) return p;
            }
        }
        // 6. First-name match against full names
        for (const p of onFieldPlayers) {
            const first = (p.name || '').split(/\s+/)[0].toLowerCase();
            if (first && first === lower) return p;
        }
        return null;
    }

    /**
     * Get the on-field Player objects for the current point. Returns [] if no
     * active point. `point.players` entries may be roster names OR player ids
     * (id-era games), so resolution goes through the era-aware
     * buildPointPlayerLookup — NOT getPlayerFromName — per the convention
     * documented at that helper. With name-only lookup an id-era point
     * resolved to zero players, so the slow pass got an empty roster and
     * every extracted event was silently dropped.
     */
    function getOnFieldPlayers() {
        if (typeof currentGame !== 'function') return [];
        const game = currentGame();
        if (!game || !game.points || !game.points.length) return [];
        const pt = game.points[game.points.length - 1];
        if (!pt || !pt.players) return [];
        // .player (real roster Player, or null) rather than .obj: narration
        // increments stats on these objects, which a display stub would
        // swallow. An entry nobody on the roster matches just doesn't narrate.
        const lookup = buildPointPlayerLookup(game);
        return pt.players
            .map(entry => lookup(entry).player)
            .filter(p => !!p);
    }

    // -----------------------------------------------------------------
    // Event application (fast pass — mirrors keyPlayDialog patterns)
    // -----------------------------------------------------------------

    /** Publish an eventAdded message to the bus. */
    function publishAdded(evt, provisionalId) {
        if (!narrationEventBus) return;
        narrationEventBus.publish('eventAdded', {
            event: evt,
            source: 'narration',
            provisionalId: provisionalId
        });
        narrationEventBus.publish('provisionalEventAdded', {
            event: evt,
            provisionalId: provisionalId
        });
    }

    function nextProvisionalId() {
        provisionalIdCounter += 1;
        return `prov-${Date.now()}-${provisionalIdCounter}`;
    }

    function applyThrow(args, onField) {
        if (typeof ensurePossessionExists !== 'function') return null;
        const thrower = resolvePlayerName(args.thrower, onField);
        const receiver = resolvePlayerName(args.receiver, onField);
        if (!thrower || !receiver) {
            console.warn('[narrationEngine] Could not resolve throw players:', args);
            return null;
        }
        const evt = new Throw({
            thrower: thrower,
            receiver: receiver,
            huck: !!args.huck,
            breakmark: !!args.break_throw,
            // "reset" is canonical; accept "dump" defensively in case the
            // model echoes the coach's word despite the schema.
            reset: !!(args.reset || args.dump),
            swing: !!args.swing,
            hammer: !!args.hammer,
            sky: !!args.sky,
            layout: !!args.layout,
            score: !!args.score
        });
        const possession = ensurePossessionExists(true);
        possession.addEvent(evt);

        // Stats updates — match keyPlayDialog behaviour
        if (thrower) thrower.completedPasses = (thrower.completedPasses || 0) + 1;
        if (evt.score_flag) {
            if (thrower) thrower.assists = (thrower.assists || 0) + 1;
            if (receiver) receiver.goals = (receiver.goals || 0) + 1;
        }

        const provId = nextProvisionalId();
        provisionalEvents.push({ id: provId, event: evt, possession, isScore: !!evt.score_flag });
        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt, provId);

        if (evt.score_flag && typeof updateScore === 'function' && typeof Role !== 'undefined') {
            updateScore(Role.TEAM);
            if (typeof moveToNextPoint === 'function') moveToNextPoint();
        }
        return evt;
    }

    function applyTurnover(args, onField) {
        if (typeof ensurePossessionExists !== 'function') return null;
        const unknown = typeof getPlayerFromName === 'function' ? getPlayerFromName('Unknown Player') : null;
        let thrower = resolvePlayerName(args.thrower, onField) || unknown;
        let receiver = resolvePlayerName(args.receiver, onField) || unknown;

        // For pure drops, swap if the model put the dropper in "thrower"
        if (args.drop && !args.receiver && args.thrower) {
            receiver = thrower;
            thrower = unknown;
        }

        const evt = new Turnover({
            thrower: thrower,
            receiver: receiver,
            throwaway: !!args.throwaway,
            huck: !!args.huck,
            receiverError: !!args.drop,
            goodDefense: !!args.good_defense,
            stall: !!args.stall
        });
        const possession = ensurePossessionExists(true);
        possession.addEvent(evt);

        const provId = nextProvisionalId();
        provisionalEvents.push({ id: provId, event: evt, possession });
        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt, provId);
        return evt;
    }

    function applyDefense(args, onField) {
        if (typeof ensurePossessionExists !== 'function') return null;
        const defender = resolvePlayerName(args.defender, onField);
        if (!defender) {
            console.warn('[narrationEngine] Could not resolve defender:', args);
            return null;
        }
        const evt = new Defense({
            defender: defender,
            block: !!args.block,
            interception: !!args.interception,
            layout: !!args.layout,
            sky: !!args.sky,
            Callahan: !!args.callahan
        });
        const possession = ensurePossessionExists(false);
        possession.addEvent(evt);

        const provId = nextProvisionalId();
        provisionalEvents.push({ id: provId, event: evt, possession, isCallahan: !!args.callahan });
        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt, provId);

        if (args.callahan && typeof updateScore === 'function' && typeof Role !== 'undefined') {
            if (defender) defender.goals = (defender.goals || 0) + 1;
            updateScore(Role.TEAM);
            if (typeof moveToNextPoint === 'function') moveToNextPoint();
        }
        return evt;
    }

    function applyOpponentScore() {
        if (typeof updateScore === 'function' && typeof Role !== 'undefined') {
            updateScore(Role.OPPONENT);
            if (typeof moveToNextPoint === 'function') moveToNextPoint();
        }
        if (typeof logEvent === 'function') logEvent('Opponent scored');
    }

    // -----------------------------------------------------------------
    // Slow pass
    // -----------------------------------------------------------------

    async function runSlowPass() {
        if (!accumulatedTranscript.trim()) {
            // Nothing was transcribed — clear provisionals and move on.
            // Say so: an empty transcript is also the signature of a dead
            // audio/socket path (the G5 failure mode), and silence here left
            // that indistinguishable from a working no-op.
            toast('Narration: no speech was captured', 'warning');
            provisionalEvents.forEach(p => markProvisionalStatus(p.id, 'confirmed'));
            if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
            return;
        }

        const apiBase = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
        const game = typeof currentGame === 'function' ? currentGame() : null;
        const gameId = game ? game.id : null;
        if (!gameId) {
            // No game context — just confirm all provisionals.
            provisionalEvents.forEach(p => markProvisionalStatus(p.id, 'confirmed'));
            if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
            return;
        }

        const onField = getOnFieldPlayers();
        const payload = {
            game_id: gameId,
            transcript: accumulatedTranscript,
            roster: onField.map(p => ({
                name: p.name,
                nickname: p.nickname || null,
                number: p.number || null
            })),
            provisional_events: provisionalEvents.map(p => ({
                id: p.id,
                type: p.event.type,
                summary: typeof p.event.summarize === 'function' ? p.event.summarize() : ''
            })),
            game_context: {
                offense: game.points && game.points.length
                    ? (game.points[game.points.length - 1].startingPosition === 'offense')
                    : true,
                our_score: game.scores ? game.scores.team : 0,
                their_score: game.scores ? game.scores.opponent : 0,
                point: game.points ? game.points.length : 0
            }
        };

        try {
            const resp = await authFetch(`${apiBase}${FINALIZE_ENDPOINT}`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (!resp.ok) {
                console.warn('[narrationEngine] Finalize failed:', resp.status);
                toast(`Narration processing failed (${resp.status}) — no events added`, 'error');
                // Leave provisionals as-is; user can undo if needed.
                provisionalEvents.forEach(p => markProvisionalStatus(p.id, 'confirmed'));
            } else {
                const data = await resp.json();
                if (data.error) {
                    // The server degraded gracefully (Claude call failed) and
                    // returned confirm-all — which in transcription-only mode
                    // means zero events. Surface it instead of looking done.
                    console.warn('[narrationEngine] Finalize degraded:', data.error);
                    toast('Narration processing failed on the server — no events added', 'error');
                }
                const { added, dropped } = applySlowPassOperations(data.operations || []);
                if (dropped > 0) {
                    toast(`Narration: ${added} event${added === 1 ? '' : 's'} added, ${dropped} couldn't be matched to on-field players`, 'warning');
                } else if (added > 0) {
                    toast(`Narration: ${added} event${added === 1 ? '' : 's'} added`, 'success');
                } else if (!data.error) {
                    toast('Narration: no game events found in the transcript', 'info');
                }
            }
        } catch (err) {
            console.error('[narrationEngine] Slow pass error:', err);
            toast('Narration processing failed (network) — no events added', 'error');
            // Best-effort: confirm what we have.
            provisionalEvents.forEach(p => markProvisionalStatus(p.id, 'confirmed'));
        }

        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    }

    /**
     * Apply the operations returned by the slow-pass backend.
     * Each operation: { op: 'CONFIRM' | 'RETRACT' | 'ADD' [+ defensive 'AMEND'], provisional_id, event? }
     *
     * AMEND is no longer emitted by the backend prompt — it's handled here as
     * a defensive fallback (treat as RETRACT) in case Claude ignores the
     * instructions.
     */
    function applySlowPassOperations(operations) {
        const onField = getOnFieldPlayers();
        let added = 0;
        let dropped = 0;
        for (const op of operations) {
            switch (op.op) {
                case 'CONFIRM':
                    markProvisionalStatus(op.provisional_id, 'confirmed');
                    break;
                case 'RETRACT':
                    retractProvisional(op.provisional_id);
                    break;
                case 'ADD':
                    // Appliers return the created event, or null when the
                    // event couldn't be applied (usually: a player name that
                    // matched nobody on field). Count both so the caller can
                    // tell the coach instead of dropping events silently.
                    if (applySlowPassAdd(op.event, onField)) {
                        added += 1;
                    } else {
                        dropped += 1;
                    }
                    break;
                case 'AMEND':
                    // Defensive: prompt says don't emit this. Treat as retract
                    // so at minimum we don't leave a wrong event in the log.
                    console.warn('[narrationEngine] Unexpected AMEND op (should be RETRACT+ADD); treating as retract');
                    retractProvisional(op.provisional_id);
                    break;
                default:
                    console.warn('[narrationEngine] Unknown operation:', op);
            }
        }
        // Any provisionals not mentioned default to confirmed.
        provisionalEvents.forEach(p => {
            if (!p._finalized) markProvisionalStatus(p.id, 'confirmed');
        });
        return { added, dropped };
    }

    /**
     * Add an event the slow pass discovered. The event spec from the backend
     * has shape:
     *   { kind: 'throw'|'turnover'|'defense'|'opponent_score', <flags & names> }
     *
     * We route through the SAME fast-pass apply functions (applyThrow, etc.)
     * so that event creation, possession handling, stats, logging, and bus
     * publishing all stay consistent.
     */
    /** @returns {object|boolean|null} The applied event (truthy) or null when dropped. */
    function applySlowPassAdd(eventSpec, onField) {
        if (!eventSpec || !eventSpec.kind) {
            console.warn('[narrationEngine] Slow pass ADD missing kind:', eventSpec);
            return null;
        }
        // Translate the backend's snake_case field names to the shape our
        // fast-pass appliers already expect (they mirror the Realtime tool
        // schema). Keys are identical by design — forward as-is.
        switch (eventSpec.kind) {
            case 'throw':
                return applyThrow(eventSpec, onField);
            case 'turnover':
                return applyTurnover(eventSpec, onField);
            case 'defense':
                return applyDefense(eventSpec, onField);
            case 'opponent_score':
                applyOpponentScore();
                return true;
            default:
                console.warn('[narrationEngine] Slow pass ADD unknown kind:', eventSpec.kind);
                return null;
        }
    }

    function markProvisionalStatus(provisionalId, status /* 'confirmed' | 'amended' | 'retracted' */) {
        const prov = provisionalEvents.find(p => p.id === provisionalId);
        if (!prov) return;
        prov._finalized = true;

        if (!narrationEventBus) return;
        if (status === 'confirmed') {
            narrationEventBus.publish('provisionalEventFinalized', {
                provisionalId, status: 'confirmed', event: prov.event
            });
        }
    }

    function retractProvisional(provisionalId) {
        const prov = provisionalEvents.find(p => p.id === provisionalId);
        if (!prov) return;
        prov._finalized = true;

        // Remove from possession
        if (prov.possession && prov.possession.events) {
            const idx = prov.possession.events.indexOf(prov.event);
            if (idx >= 0) prov.possession.events.splice(idx, 1);
        }
        // Revert stats (mirror undoEvent logic for each type)
        revertEventStats(prov.event);

        if (typeof logEvent === 'function') logEvent(`Retracted: ${prov.event.summarize ? prov.event.summarize() : prov.event.type}`);
        if (narrationEventBus) {
            narrationEventBus.publish('eventRetracted', {
                event: prov.event, source: 'narration', provisionalId
            });
            narrationEventBus.publish('provisionalEventFinalized', {
                provisionalId, status: 'retracted', event: prov.event
            });
        }
    }

    function revertEventStats(evt) {
        if (!evt) return;
        if (typeof Throw !== 'undefined' && evt instanceof Throw) {
            if (evt.thrower && typeof evt.thrower.completedPasses === 'number') {
                evt.thrower.completedPasses = Math.max(0, evt.thrower.completedPasses - 1);
            }
            if (evt.score_flag) {
                if (evt.thrower && typeof evt.thrower.assists === 'number') {
                    evt.thrower.assists = Math.max(0, evt.thrower.assists - 1);
                }
                if (evt.receiver && typeof evt.receiver.goals === 'number') {
                    evt.receiver.goals = Math.max(0, evt.receiver.goals - 1);
                }
            }
        }
        if (typeof Defense !== 'undefined' && evt instanceof Defense && evt.Callahan_flag) {
            if (evt.defender && typeof evt.defender.goals === 'number') {
                evt.defender.goals = Math.max(0, evt.defender.goals - 1);
            }
        }
    }

    // -----------------------------------------------------------------
    // Public: start / stop recording
    // -----------------------------------------------------------------

    async function startRecording() {
        if (recording || phase === 'connecting') return;
        if (!narrationRealtimeSession) {
            throw new Error('Realtime session module not loaded');
        }

        setPhase('connecting');
        abortRequested = false;
        provisionalEvents = [];
        accumulatedTranscript = '';

        const onField = getOnFieldPlayers();
        const rosterInfo = onField.map(p => ({
            name: p.name, nickname: p.nickname || null, number: p.number || null
        }));
        // Per-device tunables from Advanced Settings (VAD eagerness, noise
        // reduction, transcription model, vocabulary biasing, force-English,
        // browser audio constraints). Falls back to module defaults when the
        // settings module isn't loaded.
        const advOpts = (advancedSettings && advancedSettings.getNarrationSessionOptions)
            ? advancedSettings.getNarrationSessionOptions(rosterInfo)
            : {};

        try {
            await narrationRealtimeSession.start({
                // Transcription-only: no LLM in the loop, no
                // acknowledgment-text spam, cheaper. We pass no tools and a
                // stripped-down system prompt so gpt-realtime doesn't try to
                // emit function calls. The live transcript still streams to
                // the UI; events are produced by the slow pass on stop.
                mode: 'transcription',
                model: REALTIME_MODEL,
                instructions: buildTranscriptOnlyInstructions(rosterInfo),
                tools: [],
                // Spread Advanced Settings: vadEagerness, noiseReduction,
                // transcriptionModel, transcriptionLanguage, transcriptionPrompt,
                // audioConstraints.
                ...advOpts,
                onTranscriptDelta: (delta) => {
                    accumulatedTranscript += delta;
                    // Publish for the live transcript display UI to render.
                    if (narrationEventBus) {
                        narrationEventBus.publish('transcriptUpdated', {
                            delta,
                            full: accumulatedTranscript
                        });
                    }
                },
                onTranscriptComplete: (utterance) => {
                    // Some servers emit only complete transcripts; merge if we
                    // haven't already picked up this text via deltas (shared
                    // rule with realtimeSession's own accumulator).
                    const merged = mergeCompletedUtterance(accumulatedTranscript, utterance);
                    if (merged !== accumulatedTranscript) {
                        accumulatedTranscript = merged;
                        if (narrationEventBus) {
                            narrationEventBus.publish('transcriptUpdated', {
                                delta: utterance,
                                full: accumulatedTranscript
                            });
                        }
                    }
                },
                onError: (err) => {
                    console.error('[narrationEngine] Session error:', err);
                    // Abnormal socket close / fatal session error while we were
                    // recording or connecting: reconcile our state so the UI
                    // doesn't latch in "recording". (During 'finalizing' the stop
                    // path owns the phase, so leave it alone.) A live-recording
                    // death gets a toast here; a connect-phase failure surfaces
                    // through startRecording()'s throw → micButton's toast, so
                    // it stays silent here to avoid double-toasting.
                    if (phase === 'recording') {
                        recording = false;
                        setPhase('idle');
                        toast('Narration stopped: ' + (err && err.message ? err.message : 'connection lost'), 'error');
                    } else if (phase === 'connecting') {
                        recording = false;
                        setPhase('idle');
                    }
                }
            });

            // If a stop was requested while we were connecting, don't go live —
            // tear the just-opened session back down and return to idle.
            if (abortRequested) {
                abortRequested = false;
                try {
                    if (narrationRealtimeSession.isActive()) {
                        await narrationRealtimeSession.stop();
                    }
                } catch (_) { /* best-effort teardown */ }
                recording = false;
                setPhase('idle');
                return;
            }

            recording = true;
            setPhase('recording');
        } catch (err) {
            recording = false;
            abortRequested = false;
            setPhase('idle');
            throw err;
        }
    }

    async function stopRecording() {
        // If we're still connecting, the realtime session isn't live yet — flag
        // an abort so startRecording()'s continuation tears it down once it
        // resolves, rather than racing it here (which would let it finish
        // connecting and leave the mic hot).
        if (phase === 'connecting') {
            abortRequested = true;
            return;
        }
        if (!recording) return;
        recording = false;

        try {
            if (narrationRealtimeSession && narrationRealtimeSession.isActive()) {
                const result = await narrationRealtimeSession.stop();
                if (result && result.transcript) {
                    // Use the session's own transcript as the source of truth
                    // for the slow pass — it's what the server actually heard.
                    accumulatedTranscript = result.transcript;
                }
            }
        } catch (err) {
            console.error('[narrationEngine] stop error:', err);
        }

        setPhase('finalizing');
        try {
            await runSlowPass();
        } finally {
            setPhase('idle');
        }
    }

    // Public API
    return {
        startRecording,
        stopRecording,
        isRecording,
        getPhase,
        // Inspection helpers (import { narrationEngine } — the window shim
        // was removed at the end of the ES-module migration):
        //   narrationEngine.getTranscript()   // accumulated text
        //   narrationEngine.getProvisionals() // events from fast pass
        getTranscript: () => accumulatedTranscript,
        getProvisionals: () => provisionalEvents.slice(),
        _resolvePlayerName: resolvePlayerName,
        // Debug seam: inspect the era-resolved on-field roster the way the
        // slow pass will see it (empty here = events would be dropped).
        _getOnFieldPlayers: getOnFieldPlayers
    };
})();

// --- ES-module export (main.js imports this for isReloadUnsafe; devtools
// --- narration debugging goes through the documented window.narrationMicButton
// --- seam and the engine's exported API).
export { narrationEngine };
