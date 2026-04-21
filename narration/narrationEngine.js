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

(function() {
    const FINALIZE_ENDPOINT = '/api/narration/finalize';
    const REALTIME_MODEL = 'gpt-4o-mini-realtime-preview';

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------
    let phase = 'idle';  // 'idle' | 'connecting' | 'recording' | 'finalizing'
    let recording = false;
    let provisionalEvents = [];  // { id, event, possession, pointIndex }
    let accumulatedTranscript = '';
    let provisionalIdCounter = 0;

    function setPhase(p) {
        phase = p;
        if (window.narrationMicButton && window.narrationMicButton.refresh) {
            window.narrationMicButton.refresh();
        }
    }

    function isRecording() { return recording; }
    function getPhase() { return phase; }

    // -----------------------------------------------------------------
    // Tool definitions for the Realtime API
    // -----------------------------------------------------------------
    function buildTools() {
        return [
            {
                type: 'function',
                name: 'record_throw',
                description: 'A completed pass from one player to another. Use for any successful throw + catch.',
                parameters: {
                    type: 'object',
                    properties: {
                        thrower: { type: 'string', description: 'Name of the player who threw the disc' },
                        receiver: { type: 'string', description: 'Name of the player who caught it' },
                        huck: { type: 'boolean', description: 'A long/deep throw' },
                        break_throw: { type: 'boolean', description: 'A break-side throw (around/through the mark)' },
                        dump: { type: 'boolean', description: 'A short backward reset throw' },
                        hammer: { type: 'boolean', description: 'An overhead hammer throw' },
                        sky: { type: 'boolean', description: 'Receiver skied/jumped over a defender' },
                        layout: { type: 'boolean', description: 'Receiver laid out (dove) for the catch' },
                        score: { type: 'boolean', description: 'This throw scored a goal' }
                    },
                    required: ['thrower', 'receiver']
                }
            },
            {
                type: 'function',
                name: 'record_turnover',
                description: 'A turnover: throwaway, drop, or stall. Attribute to the responsible player.',
                parameters: {
                    type: 'object',
                    properties: {
                        thrower: { type: 'string', description: 'Thrower on the turnover (always set unless pure drop with unknown thrower)' },
                        receiver: { type: 'string', description: 'Intended receiver, if applicable (e.g. who dropped it)' },
                        throwaway: { type: 'boolean', description: 'Thrower missed everyone / went out of bounds' },
                        drop: { type: 'boolean', description: 'Receiver dropped a catchable pass' },
                        huck: { type: 'boolean', description: 'Happened on a huck' },
                        good_defense: { type: 'boolean', description: 'Caused by strong defensive pressure' },
                        stall: { type: 'boolean', description: 'Thrower got stalled out' }
                    }
                }
            },
            {
                type: 'function',
                name: 'record_defense',
                description: 'A defensive play that creates a turnover (interception, block, layout D).',
                parameters: {
                    type: 'object',
                    properties: {
                        defender: { type: 'string', description: 'Name of the defender making the play' },
                        interception: { type: 'boolean' },
                        layout: { type: 'boolean' },
                        sky: { type: 'boolean' },
                        callahan: { type: 'boolean', description: 'Defender caught it in the endzone for a score' }
                    },
                    required: ['defender']
                }
            },
            {
                type: 'function',
                name: 'record_opponent_score',
                description: 'The opposing team scored (we were on defense and they completed a goal).',
                parameters: { type: 'object', properties: {} }
            }
        ];
    }

    function buildInstructions(rosterInfo, gameContext) {
        const rosterLines = rosterInfo.map(p => {
            const parts = [p.name];
            if (p.nickname) parts.push(`"${p.nickname}"`);
            if (p.number) parts.push(`#${p.number}`);
            return `- ${parts.join(' ')}`;
        }).join('\n');

        return `You are tracking a live ultimate frisbee game from a coach's spoken narration.

On-field players (our team):
${rosterLines}

Current context: we are on ${gameContext.offense ? 'OFFENSE' : 'DEFENSE'}. Score: our team ${gameContext.ourScore}, opponent ${gameContext.theirScore}.

Convert the coach's narration into game events by calling the provided functions:
- Call record_throw for completed passes.
- Call record_turnover for throwaways, drops, or stalls.
- Call record_defense for interceptions / blocks / layout Ds.
- Call record_opponent_score when the OTHER team scores.
- A completed pass into the endzone is a record_throw with score=true.
- A Callahan (D caught in endzone) is record_defense with callahan=true.

Names may be partial, nicknames, or jersey numbers — match to the closest player.
Call functions as events happen. If the coach corrects themselves mid-sentence,
use the corrected version. Be lenient: better to emit a best-guess event than nothing.
Do not produce any text responses — only function calls.`;
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
     * active point. Looks up from the latest point's players array (names) and
     * resolves each to a Player object via getPlayerFromName.
     */
    function getOnFieldPlayers() {
        if (typeof currentGame !== 'function') return [];
        const game = currentGame();
        if (!game || !game.points || !game.points.length) return [];
        const pt = game.points[game.points.length - 1];
        if (!pt || !pt.players) return [];
        return pt.players
            .map(name => typeof getPlayerFromName === 'function' ? getPlayerFromName(name) : null)
            .filter(p => !!p);
    }

    // -----------------------------------------------------------------
    // Event application (fast pass — mirrors keyPlayDialog patterns)
    // -----------------------------------------------------------------

    /** Publish an eventAdded message to the bus. */
    function publishAdded(evt, provisionalId) {
        if (!window.narrationEventBus) return;
        window.narrationEventBus.publish('eventAdded', {
            event: evt,
            source: 'narration',
            provisionalId: provisionalId
        });
        window.narrationEventBus.publish('provisionalEventAdded', {
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
            dump: !!args.dump,
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

    /** Dispatch a Realtime API function call to the right applier. */
    function handleFunctionCall(name, args) {
        const onField = getOnFieldPlayers();
        try {
            switch (name) {
                case 'record_throw':        return applyThrow(args, onField);
                case 'record_turnover':     return applyTurnover(args, onField);
                case 'record_defense':      return applyDefense(args, onField);
                case 'record_opponent_score': return applyOpponentScore();
                default:
                    console.warn('[narrationEngine] Unknown function:', name, args);
            }
        } catch (err) {
            console.error('[narrationEngine] Function call handler threw:', err);
        }
    }

    // -----------------------------------------------------------------
    // Slow pass
    // -----------------------------------------------------------------

    async function runSlowPass() {
        if (!accumulatedTranscript.trim()) {
            // Nothing was transcribed — clear provisionals and move on.
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
                // Leave provisionals as-is; user can undo if needed.
                provisionalEvents.forEach(p => markProvisionalStatus(p.id, 'confirmed'));
            } else {
                const data = await resp.json();
                applySlowPassOperations(data.operations || []);
            }
        } catch (err) {
            console.error('[narrationEngine] Slow pass error:', err);
            // Best-effort: confirm what we have.
            provisionalEvents.forEach(p => markProvisionalStatus(p.id, 'confirmed'));
        }

        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    }

    /**
     * Apply the operations returned by the slow-pass backend.
     * Each operation: { op: 'CONFIRM' | 'AMEND' | 'RETRACT' | 'ADD', provisional_id, event? }
     */
    function applySlowPassOperations(operations) {
        for (const op of operations) {
            switch (op.op) {
                case 'CONFIRM':
                    markProvisionalStatus(op.provisional_id, 'confirmed');
                    break;
                case 'RETRACT':
                    retractProvisional(op.provisional_id);
                    break;
                case 'AMEND':
                    amendProvisional(op.provisional_id, op.event);
                    break;
                case 'ADD':
                    // Slow pass discovered an event not in provisionals.
                    // For now, log it; full "ADD" implementation requires
                    // building the right Event and inserting at the right
                    // position. Left for a follow-up iteration.
                    console.log('[narrationEngine] Slow pass ADD (not yet applied):', op.event);
                    break;
                default:
                    console.warn('[narrationEngine] Unknown operation:', op);
            }
        }
        // Any provisionals not mentioned default to confirmed.
        provisionalEvents.forEach(p => {
            if (!p._finalized) markProvisionalStatus(p.id, 'confirmed');
        });
    }

    function markProvisionalStatus(provisionalId, status /* 'confirmed' | 'amended' | 'retracted' */) {
        const prov = provisionalEvents.find(p => p.id === provisionalId);
        if (!prov) return;
        prov._finalized = true;

        if (!window.narrationEventBus) return;
        if (status === 'confirmed') {
            window.narrationEventBus.publish('provisionalEventFinalized', {
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
        if (window.narrationEventBus) {
            window.narrationEventBus.publish('eventRetracted', {
                event: prov.event, source: 'narration', provisionalId
            });
            window.narrationEventBus.publish('provisionalEventFinalized', {
                provisionalId, status: 'retracted', event: prov.event
            });
        }
    }

    function amendProvisional(provisionalId, newEventSpec) {
        // For v1, implement AMEND as retract + add. A tighter in-place swap
        // can be added later.
        retractProvisional(provisionalId);
        // TODO (follow-up): build Event from newEventSpec and add it. For now
        // the slow-pass prompt should prefer RETRACT + ADD over AMEND.
        if (window.narrationEventBus) {
            window.narrationEventBus.publish('provisionalEventFinalized', {
                provisionalId, status: 'amended', newEvent: newEventSpec
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
        if (recording) return;
        if (!window.narrationRealtimeSession) {
            throw new Error('Realtime session module not loaded');
        }

        setPhase('connecting');
        provisionalEvents = [];
        accumulatedTranscript = '';

        const onField = getOnFieldPlayers();
        const rosterInfo = onField.map(p => ({
            name: p.name, nickname: p.nickname || null, number: p.number || null
        }));
        const game = typeof currentGame === 'function' ? currentGame() : null;
        const gameContext = {
            offense: game && game.points && game.points.length
                ? (game.points[game.points.length - 1].startingPosition === 'offense')
                : true,
            ourScore: game && game.scores ? game.scores.team : 0,
            theirScore: game && game.scores ? game.scores.opponent : 0
        };

        try {
            await window.narrationRealtimeSession.start({
                model: REALTIME_MODEL,
                instructions: buildInstructions(rosterInfo, gameContext),
                tools: buildTools(),
                onFunctionCall: handleFunctionCall,
                onTranscriptDelta: (delta) => {
                    accumulatedTranscript += delta;
                },
                onTranscriptComplete: (utterance) => {
                    // Some servers emit only complete transcripts; merge if we
                    // haven't already picked up this text via deltas.
                    if (utterance && !accumulatedTranscript.endsWith(utterance)) {
                        accumulatedTranscript += utterance;
                    }
                },
                onError: (err) => console.error('[narrationEngine] Session error:', err)
            });
            recording = true;
            setPhase('recording');
        } catch (err) {
            recording = false;
            setPhase('idle');
            throw err;
        }
    }

    async function stopRecording() {
        if (!recording && phase !== 'connecting') return;
        recording = false;

        try {
            if (window.narrationRealtimeSession && window.narrationRealtimeSession.isActive()) {
                const result = await window.narrationRealtimeSession.stop();
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

    // Expose
    window.narrationEngine = {
        startRecording,
        stopRecording,
        isRecording,
        getPhase,
        // Exposed for tests / inspection
        _resolvePlayerName: resolvePlayerName
    };
})();
