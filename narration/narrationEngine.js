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
    // OpenAI Realtime API GA model. The older `gpt-4o-realtime-preview` has
    // graduated; `gpt-realtime` is the current production identifier.
    // `gpt-realtime-mini` is a cheaper variant if cost becomes a concern.
    const REALTIME_MODEL = 'gpt-realtime';

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

IMPORTANT — a single utterance from the coach often describes MULTIPLE
events chained together ("A throws to B, who sends it deep to C for the
score, it's a layout catch"). You MUST emit a SEPARATE function call for
EACH event before your response ends. Do not stop after the first event.
Keep calling functions until every event in the utterance has been
recorded.

Event-to-function mapping:
- Call record_throw for each completed pass.
- Call record_turnover for throwaways, drops, or stalls.
- Call record_defense for interceptions / blocks / layout Ds.
- Call record_opponent_score when the OTHER team scores.
- A completed pass into the endzone is a record_throw with score=true.
- A Callahan (D caught in endzone) is record_defense with callahan=true.
- A "reset" or "dump" throw is record_throw with dump=true.
- A "break" (thrower goes around the mark) is record_throw with break_throw=true.
- A "huck" or "deep throw" or "long throw" is record_throw with huck=true.
- A "sky" (jumped over defender) is sky=true on the throw or defense.
- A "layout" (dive) is layout=true on the throw or defense.

Names may be partial, nicknames, or jersey numbers — match to the closest
player. If the coach corrects themselves mid-sentence, use the corrected
version. Be lenient: better to emit a best-guess event than nothing.

Do not produce any text responses — only function calls. Emit one
function call per event, multiple per response as needed.`;
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
        console.log(`[narrationEngine] fn call: ${name}`, args);
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
     * Each operation: { op: 'CONFIRM' | 'RETRACT' | 'ADD' [+ defensive 'AMEND'], provisional_id, event? }
     *
     * AMEND is no longer emitted by the backend prompt — it's handled here as
     * a defensive fallback (treat as RETRACT) in case Claude ignores the
     * instructions.
     */
    function applySlowPassOperations(operations) {
        const onField = getOnFieldPlayers();
        for (const op of operations) {
            switch (op.op) {
                case 'CONFIRM':
                    markProvisionalStatus(op.provisional_id, 'confirmed');
                    break;
                case 'RETRACT':
                    retractProvisional(op.provisional_id);
                    break;
                case 'ADD':
                    applySlowPassAdd(op.event, onField);
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
    function applySlowPassAdd(eventSpec, onField) {
        if (!eventSpec || !eventSpec.kind) {
            console.warn('[narrationEngine] Slow pass ADD missing kind:', eventSpec);
            return;
        }
        // Translate the backend's snake_case field names to the shape our
        // fast-pass appliers already expect (they mirror the Realtime tool
        // schema). Keys are identical by design — forward as-is.
        switch (eventSpec.kind) {
            case 'throw':
                applyThrow(eventSpec, onField);
                break;
            case 'turnover':
                applyTurnover(eventSpec, onField);
                break;
            case 'defense':
                applyDefense(eventSpec, onField);
                break;
            case 'opponent_score':
                applyOpponentScore();
                break;
            default:
                console.warn('[narrationEngine] Slow pass ADD unknown kind:', eventSpec.kind);
        }
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
        // Inspection helpers — useful from the devtools console:
        //   window.narrationEngine.getTranscript()   // accumulated text
        //   window.narrationEngine.getProvisionals() // events from fast pass
        getTranscript: () => accumulatedTranscript,
        getProvisionals: () => provisionalEvents.slice(),
        _resolvePlayerName: resolvePlayerName
    };
})();
